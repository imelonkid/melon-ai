# melon-ai

可嵌入的 AI Agent 内核。运行时、记忆、存储、模型、技能来源都是可替换组件，
通过依赖倒置接入任意宿主应用。

```
@melon-ai/core     契约：类型与端口，零运行时依赖
@melon-ai/engine   引擎：任务状态机 · 运行时调度 · 定时编排
@melon-ai/skills   技能：工具调用管线（六段）· 准入策略 · 工具注册 · 联网（/web 子路径）
@melon-ai/llm      模型：路由 · ReAct 规划器 · OpenAI 兼容适配器（Claude 在 /anthropic 子路径）
@melon-ai/store    存储：SQLite 在 /sqlite 子路径
@melon-ai/audit    审计：哈希链、脱敏、保留期（横切，独立成包）
@melon-ai/agent    组装：createAgent，宿主的入口
@melon-ai/testkit  测试替身与驱动器
```

按职责分包，而不是一个组件一个包 —— 见架构文档 §4.2。
包内按目录分层，目录之间的依赖方向同样由 `lint:deps` 强制。

## 文档

- [架构设计](./docs/architecture.md) —— 分层、模块划分、技术选型、设计原则
  - §2 八条设计原则（依赖倒置 / 引用优先于负载 / 一切读写经由工具 …）
  - §10 当前进度、宿主集成进度、下一步
  - §10 的编号条目是**实现与验收中暴露的设计问题及其修正**，按时间顺序累积
- [内核机制](./docs/kernel-design.md) —— 状态机、三层记忆、工具管线、上下文预算

## 接入

宿主**只装 `@melon-ai/agent`**：

```ts
import { createAgent, defineTool, deepseek } from '@melon-ai/agent';

const agent = await createAgent({ models: [deepseek({ apiKey })] });
agent.on('task', (task) => console.log(task.state, task.outcome?.answer));
await agent.run('汇总本周进展');
```

持久化、Claude、联网等可选能力走子路径（`@melon-ai/agent/sqlite`、`/anthropic`、`/web`）。
完整说明见架构文档 §7。

## 开发

```bash
pnpm install
pnpm typecheck      # 各包严格模式类型检查
pnpm build          # tsup 输出 ESM + CJS
pnpm test           # 全部包的测试
pnpm lint:deps      # 校验分层依赖方向没被破坏
```

> `lint:deps` 用的是 `tsconfig.depcruise.json`（把包名映射到各包 src），
> 不是构建用的 `tsconfig.base.json`。原因见架构文档 §10 第 46 条 ——
> 走默认解析的话跨包依赖会被 `dist` 的 exclude 吃掉，规则会静默空转。

## 状态

P0 已完成并通过验收（带审批的两步任务，进程重启后从事件日志恢复继续执行）。
**250 个测试全绿**，`lint:deps` 零违规。

已接入首个宿主 [Jolly](../jolly)，真实模型（DeepSeek / Claude / OpenAI 兼容）跑通。
待建：`@melon-ai/memory`（三层记忆 + 上下文装配）；skills 里的技能召回、内置工具、MCP。

逐项进度与下一步见架构文档 §10。
