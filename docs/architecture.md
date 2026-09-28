# melon-ai 架构设计

> 状态：初稿，待评审
> 本文覆盖**框架整体架构、模块划分、技术选型**。
> 内核运行机制（状态机细节、三层记忆、工具管线、上下文压缩）见 [kernel-design.md](./kernel-design.md)。

---

## 1. 这是什么，不是什么

**melon-ai 是一个可嵌入的 AI Agent 内核**。目标是被集成进任意宿主应用 —— 桌面端（Electron）、服务端（Node）、CLI，甚至浏览器 —— 而不是一个开箱即用的产品。

**是**：

- 一套 Agent 运行机制：任务状态机、三层记忆、技能与工具、上下文预算
- 一组可替换的组件：运行时、记忆、存储、模型、技能来源都能换
- 一个不假设宿主形态的库：不绑 UI、不绑传输层、不绑数据库

**不是**：

- 不是应用框架。它不管路由、不管界面、不管进程模型。
- 不是 LangChain 那类「链式胶水」。我们要的是内核 —— 状态、预算、准入、可重放，而不是把 prompt 拼起来。
- 不是多租户服务。一期假设单机单用户（见 §5 假设 A3）。

**首个宿主是 Jolly**（AI 工作台桌面应用），但框架里不应出现任何 Jolly 的痕迹。Jolly 特有的东西（周报助手、AI 源页面、看板 UI）留在 Jolly 侧。

---

## 2. 设计原则

这四条是后面所有决定的依据，冲突时按顺序取舍。

### 2.1 依赖倒置优先于一切

领域逻辑**只依赖接口，永远不依赖具体实现**。

```
        ┌──────────────┐
        │  melon-core  │   ← 只有类型和端口，零运行时依赖
        └──────┬───────┘
               │ 所有人都依赖它
    ┌──────────┼──────────┐
    │          │          │
领域模块    运行时模块   基础设施模块
（实现业务） （编排）    （实现端口）
    └──────────┼──────────┘
               │
        ┌──────┴───────┐
        │ melon-agent  │   ← 唯一允许 import 所有层的地方（组装）
        └──────────────┘
```

关键约束：**基础设施模块只依赖 melon-core**。`melon-store-sqlite` 不认识 `melon-memory`，`melon-memory` 也不认识 `melon-store-sqlite`。两者通过 `melon-core` 里的 `MemoryStore` 端口相遇。

这条约束**必须可执行，不能靠自觉** —— 见 §4.3。

### 2.2 机制与策略分离

内核提供机制（状态机、预算、准入管线），策略可替换（怎么规划、怎么召回、怎么打分）。

具体体现：`melon-runtime` 驱动状态机（机制，一份实现），`Planner` 决定下一步做什么（策略，可插拔 —— ReAct 只是其中一种）。

### 2.3 纯函数优先，副作用集中

状态机是纯函数 `reduce(task, event) → { task, effects }`，自己不做 I/O；副作用以描述形式返回，由 EffectRunner 统一执行。

换来：不碰模型和数据库就能测完全部状态迁移；事件日志可重放；崩溃可恢复。
代价：比直接 `await` 多一层间接。**接受**。

### 2.4 宿主无关

框架不 import 任何宿主环境的东西（没有 `electron`、没有 `fs` 的硬依赖、没有全局单例）。时间、随机数、日志都是端口（`Clock` / `IdGen` / `Logger`），因为状态机的可测性依赖于此。

---

## 3. 分层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ Tier 4  组装层                                                       │
│   melon-agent          facade，把所有组件接起来。宿主只 import 这个   │
├─────────────────────────────────────────────────────────────────────┤
│ Tier 3  基础设施层           （只依赖 melon-core）                    │
│   melon-store-sqlite   一期：全套存储端口的 SQLite 实现               │
│   melon-llm-*          模型适配器                                    │
│   melon-mcp            SkillProvider 的 MCP 实现                     │
├─────────────────────────────────────────────────────────────────────┤
│ Tier 2  运行时层                                                     │
│   melon-runtime        调度器 + EffectRunner + AgentEngine 实现       │
│   melon-planner-react  ReAct 规划器（Planner 的一种实现）             │
├─────────────────────────────────────────────────────────────────────┤
│ Tier 1  领域层               （只依赖 melon-core）                    │
│   melon-task      melon-tools     melon-skills                      │
│   melon-memory    melon-context   melon-policy                      │
├─────────────────────────────────────────────────────────────────────┤
│ Tier 0  契约层                                                       │
│   melon-core           类型 + 端口。零运行时依赖。倒置中心            │
└─────────────────────────────────────────────────────────────────────┘

横切：melon-testkit   内存适配器 + 假模型，供上面所有层测试用
```

---

## 4. 模块划分

### 4.1 模块清单

| 模块 | 职责 | 依赖 | 期次 |
|---|---|---|---|
| **melon-core** | 全部类型与端口定义。`Task` / `Memory` / `Skill` / `ToolResult` / 各 Store 端口 / `Planner` / `AgentEngine` | 无 | P0 |
| **melon-task** | Task 模型、纯 reducer、合法迁移表、预算核算 | core | P0 |
| **melon-policy** | 风险×策略准入矩阵、grant 匹配、配额检查 | core | P0 |
| **melon-tools** | 工具管线六段（解析→校验→准入→执行→归一化→记录）+ 中间件链 | core, policy | P0 |
| **melon-runtime** | 调度器、EffectRunner、`AgentEngine` 实现、停止条件（循环/无进展检测） | core, task, tools, context, skills, memory, policy | P0 |
| **melon-store-sqlite** | 全套存储端口的 SQLite 实现（含向量） | core | P0 |
| **melon-testkit** | 内存适配器、假模型、事件日志断言工具 | core | P0 |
| **melon-agent** | facade：`createAgent(deps)`，宿主唯一入口 | 全部 | P0 |
| **melon-context** | 上下文装配、预算分配、episode 压缩 | core, memory, skills | P1 |
| **melon-memory** | L0/L1/L2 管理，检索融合、提升、冲突消解 | core | P1 |
| **melon-skills** | 技能注册表、召回、动态注册与健康检查 | core | P1 |
| **melon-planner-react** | ReAct 规划器 + 意图分类短路 | core, context | P1 |
| **melon-llm-\*** | 模型适配器（anthropic / openai / …） | core | P1 |
| **melon-mcp** | MCP 协议适配为 `SkillProvider` | core | P2 |

### 4.2 为什么一个组件一个模块

好处不是「整洁」，是三件可验证的事：

1. **依赖方向变成可强制的**。分包之后，`melon-memory` 想 import `melon-store-sqlite` 得先在 package.json 里加依赖 —— 这一步会被 CI 拦住。单包内部靠目录分层，只能靠自觉，迟早会破。
2. **宿主按需安装**。只想用任务状态机、不想要向量检索的宿主，不必把 sqlite-vec 拖进来。
3. **独立演进**。适配器的版本节奏和内核不同，MCP 协议变了只动 `melon-mcp`。

代价也要认：包多了之后版本管理、发布流程、跨包重构都更麻烦。缓解办法是**一期只建 8 个 P0 包**，其余等真正要写时再拆出来 —— 不预先创建一堆空目录。

### 4.3 依赖方向的强制机制

光写规范没用。用 `dependency-cruiser` 在 CI 里拦：

```js
// .dependency-cruiser.cjs（要点）
forbidden: [
  { name: 'core-is-pure',
    from: { path: '^packages/melon-core' },
    to:   { path: '^packages/(?!melon-core)' } },          // core 不依赖任何人

  { name: 'domain-no-infra',
    from: { path: '^packages/melon-(task|tools|skills|memory|context|policy)' },
    to:   { path: '^packages/melon-(store|llm|mcp)-' } },   // 领域层不碰适配器

  { name: 'infra-only-core',
    from: { path: '^packages/melon-(store|llm|mcp)-' },
    to:   { path: '^packages/(?!melon-core)' } },           // 适配器只依赖 core

  { name: 'no-adapter-to-adapter',
    from: { path: '^packages/melon-(store|llm|mcp)-' },
    to:   { path: '^packages/melon-(store|llm|mcp)-' } },   // 适配器互不认识
]
```

`melon-agent` 是唯一豁免 —— 它的职责就是组装。

### 4.4 命名约定

- 包名统一 `melon-xxx`，全小写连字符
- 适配器带类别前缀：`melon-store-*` / `melon-llm-*`
- 可插拔实现带策略名：`melon-planner-react`
- 端口定义一律在 `melon-core/src/ports/` 下，实现分散在各适配器

> 注：包名没有加 npm scope。如果将来要发到 npm，`@melon-ai/core` 比 `melon-core` 更安全（避免抢名、便于统一权限）。这条**待定**，见 §8。

---

## 5. 假设

| # | 假设 | 影响 |
|---|---|---|
| A1 | 宿主是 Node 20+ 兼容运行时（含 Electron 主进程） | 可用 Node 内置 API，但不硬依赖 |
| A2 | 一期存储为 SQLite 单文件 | 无外部服务，本地优先 |
| A3 | 单机单用户，活跃任务量级 O(10) | 进程内队列够用，不需要 MQ；单写者 |
| A4 | 扩展技能走 MCP | 适配层隔离，换协议不动内核 |
| A5 | 宿主自己提供模型访问 | 框架不内置任何 API key 管理 |

**非目标（明确不做）**：多租户、分布式调度、Agent 间协作/交接、训练闭环。

---

## 6. 技术选型

### 6.1 选了什么

| 维度 | 选择 | 理由 | 代价 |
|---|---|---|---|
| 语言 | TypeScript 5.7，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | 端口即类型，类型系统就是契约的执行者。严格档位能挡住大量适配器实现的疏漏 | 写起来更啰嗦 |
| 包管理 | **pnpm** workspace | 关键不是省空间，是**严格的 node_modules 布局**：npm 的扁平化会让 `melon-memory` 意外 import 到 `melon-store-sqlite` 的传递依赖，依赖倒置就名存实亡 | 团队得装 pnpm |
| 构建 | **tsup**（esbuild）输出 ESM + CJS 双格式 | Jolly 的 Electron 主进程目前是 CJS；双格式省掉未来的迁移 | 多一份产物 |
| 模块规范 | `NodeNext`，包内一律 `.js` 后缀导入 | 与 Node 原生解析一致，避免打包器魔法 | 写导入路径要带 `.js` |
| 测试 | `node:test` + `melon-testkit` | 零依赖；状态机是纯函数，不需要重型框架 | 断言库比 vitest 朴素 |
| 存储（一期） | **SQLite**（`better-sqlite3`）+ `sqlite-vec` | 单文件、同步 API（简化事务）、向量和关系数据同库同事务 | 并发写受限；原生模块要按平台编译 |
| 参数校验 | `ajv`，但**只在 melon-tools 内部** | 契约层不绑定校验器，将来换 zod/typebox 只动一个包 | 多一层间接 |
| 依赖方向 | `dependency-cruiser` | 见 §4.3 | CI 多跑一步 |

### 6.2 明确不选什么

**不用 DI 容器**（InversifyJS / tsyringe / NestJS）。
构造函数注入 + 一个 `createAgent(deps)` 组装函数就够了。容器会把依赖关系藏进装饰器和运行时解析里，反而让「谁依赖谁」变得不可见 —— 而这恰恰是本项目最想显式化的东西。

**不用 LangChain / LlamaIndex**。
它们解决的是「快速拼出一个 demo」，我们要的是内核：可重放的状态、硬预算、准入闸门、崩溃恢复。这些在那套抽象里是缺失的，硬接会同时背上两套心智模型。

**不用 ORM**（Prisma / Drizzle）。
存储端口只有十几个方法，手写 SQL 更可控，也避免把 ORM 的类型泄漏进领域层。SQLite 一期尤其不值得。

**一期不做 monorepo 发布流水线**（changesets 等）。
还没有外部消费者，内部用 workspace 协议引用即可。等要发 npm 再引入。

---

## 7. 集成契约

宿主应用看到的全部 API 就这些。这是「可被集成到任何应用」的具体含义：

```ts
import { createAgent } from 'melon-agent';
import { openSqliteStores } from 'melon-store-sqlite';
import { ReActPlanner } from 'melon-planner-react';

const agent = createAgent({
  stores:   await openSqliteStores({ file: './jolly.db' }),  // 换 Postgres 只改这一行
  router:   myModelRouter,      // 宿主自己的模型路由（Jolly 的「AI 源」）
  embedder: myEmbedder,
  planner:  new ReActPlanner(), // 换规划策略只改这一行
  skills:   [mailSkill, docSkill],
  providers:[mcpProvider],      // 动态技能来源
  policy:   { mode: 'ask' },    // 对应「Agent 执行权限」三档
  platform: { clock, ids, logger },
});

await agent.start();

// 提交任务
const task = await agent.submit({
  agentId: asAgentId('weekly-report'),
  kind: 'automation',
  goal: '汇总本周进展并生成周报',
  trigger: { type: 'schedule' },
});

// 订阅事件驱动 UI —— 框架不假设任何渲染方式
for await (const ev of agent.watch(task.id)) {
  switch (ev.value.t) {
    case 'ApprovalRequested': showPermissionCard(ev.value.request); break;
    case 'Observed':          appendStep(ev.value.summary);         break;
    case 'Settled':           renderAnswer(ev.value.outcome);       break;
  }
}

// 用户在权限卡上点了「允许」
await agent.resolveApproval(task.id, callId, 'allow');
```

三个要点：

1. **只吐事件，不碰 UI**。宿主决定怎么渲染，框架不知道有没有界面。
2. **换基础设施 = 换一行**。`stores` 和 `router` 都是端口。
3. **审批是异步的、可持久的**。`resolveApproval` 可以在应用重启之后调用 —— 任务状态在库里等着。

---

## 8. 待定决策

需要先拍板，会影响目录结构和发布方式：

1. **npm scope**：包名用 `melon-core` 还是 `@melon-ai/core`？发 npm 的话后者更安全（防抢名、统一权限），但和你说的 `melon-xxx` 形式不一致。**倾向后者**，想听你的意见。
2. **Embedding 来源**：本地小模型（离线、免费、质量一般）vs 走宿主的远端 embedding（质量好、要联网、计费）。直接决定 L1 检索和技能召回的效果，也决定框架能不能离线跑。
3. **是否保留 `melon-planner-react` 独立成包**：如果短期内只会有 ReAct 一种规划器，先并进 `melon-runtime`、将来再拆也可以。拆的好处是从第一天就验证 `Planner` 端口是真的可换，不是摆设。**倾向拆**。
4. **子任务并发**：Task 树里的兄弟任务允许并行吗？并行快很多，但共享 L2 会有写冲突，需要定义合并语义。一期建议**串行**。
5. **许可证**：MIT / Apache-2.0 / 私有？影响能不能直接发 npm。

---

## 9. 分期

**P0 · 骨架能跑通一次真实的工具调用**
`melon-core` / `melon-task` / `melon-policy` / `melon-tools` / `melon-runtime` / `melon-store-sqlite` / `melon-testkit` / `melon-agent`。
上下文先用固定窗口不压缩，记忆先只有 L0 + 朴素 L2。
**验收**：一个带审批的两步任务，能卡在 `AWAITING_APPROVAL`，进程重启后从事件日志恢复并继续执行完。

**P1 · 记忆与上下文**
`melon-memory` / `melon-context` / `melon-skills` / `melon-planner-react` / 首个 LLM 适配器。
**验收**：40 轮以上长会话不炸窗口；跨会话记得用户偏好；技能召回把 tool schema 控制在预算内。

**P2 · 扩展生态**
`melon-mcp` + 动态注册 + 健康检查熔断。
**验收**：装一个第三方 MCP server，不重启即可用，且**绕不过准入层**。

**P3 · 集成 Jolly**
把 Jolly 现有原型的看板、权限卡、AI 源接到 `AgentEngine` 的事件流上。

---

## 10. 当前进度

- [x] 工作区骨架（pnpm workspace + tsconfig + gitignore + README）
- [x] `melon-core` 契约层：13 个源文件，strict 模式编译通过
- [x] `melon-core` 构建产物：ESM + CJS + d.ts
      （踩了一个坑：`composite: true` 与 tsup 的 dts 构建冲突报 TS6307。
       我们用 tsup 逐包构建、不走 project references，所以直接去掉 composite，
       `typecheck` 改为逐包 `tsc --noEmit`。）
- [x] `.dependency-cruiser.cjs` 分层规则落地并通过
- [ ] `melon-task` 状态机 reducer + 迁移表
- [ ] `melon-policy` / `melon-tools` / `melon-runtime`
- [ ] `melon-store-sqlite` / `melon-testkit` / `melon-agent`
