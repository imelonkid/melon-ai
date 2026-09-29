# melon-ai

可嵌入的 AI Agent 内核。运行时、记忆、存储、模型、技能来源都是可替换组件，
通过依赖倒置接入任意宿主应用。

```
@melon-ai/core          契约层：类型与端口，零运行时依赖
@melon-ai/task          任务状态机（纯 reducer）
@melon-ai/policy        准入矩阵与授权
@melon-ai/tools         工具调用管线（六段固定流程）
@melon-ai/audit         审计哈希链
@melon-ai/router        模型路由
@melon-ai/trigger       定时编排（周期规则是纯函数）
@melon-ai/planner-react ReAct 规划器
@melon-ai/runtime       调度与编排
@melon-ai/llm-*         模型适配器（Anthropic / OpenAI 兼容）
@melon-ai/store-*       存储适配器（一期 SQLite）
@melon-ai/testkit       内存替身与驱动器
@melon-ai/agent         组装入口，宿主唯一需要 import 的包
```

## 文档

- [架构设计](./docs/architecture.md) —— 分层、模块划分、技术选型、设计原则
  - §2 八条设计原则（依赖倒置 / 引用优先于负载 / 一切读写经由工具 …）
  - §10 当前进度、宿主集成进度、下一步
  - §10 的编号条目是**实现与验收中暴露的设计问题及其修正**，按时间顺序累积
- [内核机制](./docs/kernel-design.md) —— 状态机、三层记忆、工具管线、上下文预算

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
**192 个测试全绿**，`lint:deps` 223 条依赖零违规。

已接入首个宿主 [Jolly](../jolly)，真实模型（DeepSeek / Claude / OpenAI 兼容）跑通。
待建：`@melon-ai/context` / `@melon-ai/memory` / `@melon-ai/skills-builtin` / `@melon-ai/mcp`。

逐项进度与下一步见架构文档 §10。
