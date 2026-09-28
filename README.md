# melon-ai

可嵌入的 AI Agent 内核。运行时、记忆、存储、模型、技能来源都是可替换组件，
通过依赖倒置接入任意宿主应用。

```
melon-core        契约层：类型与端口，零运行时依赖
melon-task        任务状态机（纯 reducer）
melon-policy      准入矩阵与授权
melon-tools       工具调用管线
melon-runtime     调度与编排
melon-store-*     存储适配器（一期 SQLite）
melon-agent       组装入口，宿主唯一需要 import 的包
```

## 文档

- [架构设计](./docs/architecture.md) —— 分层、模块划分、技术选型
- [内核机制](./docs/kernel-design.md) —— 状态机、三层记忆、工具管线、上下文预算

## 开发

```bash
pnpm install
pnpm typecheck      # 各包严格模式类型检查
pnpm build          # tsup 输出 ESM + CJS
pnpm lint:deps      # 校验分层依赖方向没被破坏
```

## 状态

早期开发中。`melon-core` 契约层已定型，其余模块建设中，详见架构文档 §10。
