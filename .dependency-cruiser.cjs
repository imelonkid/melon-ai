/**
 * 依赖方向的强制规则。
 * 分层约定光写在文档里没用 —— 这份配置在 CI 里跑，破坏分层会直接挂。
 * 详见 docs/architecture.md §4.3
 *
 * 两层规则：
 * 1. **包之间**：core ← skills ← engine ← agent；llm / store / audit 只认 core。
 * 2. **包内目录之间**：一个包按职责合并了几个组件，组件之间的方向同样要拦 ——
 *    例如 engine 里的 task（纯状态机）不能反过来依赖 runtime。
 *    这是合包之后分层还能被强制的前提（§4.2）。
 *
 * 规则写完必须造一个违规来验它会挂（§10 第 46 条）：「没有报错」和「检查生效了」是两回事。
 */
const pkg = (name) => `^packages/melon-${name}/`;
const dir = (name, sub) => `^packages/melon-${name}/src/${sub}/`;
const ONLY_CORE = '^packages/(?!melon-core/)';

/** from 这些路径出发，只允许依赖 core（和自己所在的目录）。 */
const onlyCore = (name, from, self) => ({
  name,
  severity: 'error',
  from: { path: from },
  to: { path: ONLY_CORE, pathNot: self },
});

module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: '@melon-ai/core 是倒置中心，不能依赖任何其他包',
      severity: 'error',
      from: { path: pkg('core') },
      to: { path: '^packages/(?!melon-core/)' },
    },

    // ── 包之间 ──
    onlyCore('skills-only-core', pkg('skills'), pkg('skills')),
    onlyCore('llm-only-core', pkg('llm'), pkg('llm')),
    onlyCore('store-only-core', pkg('store'), pkg('store')),
    onlyCore('audit-only-core', pkg('audit'), pkg('audit')),
    {
      name: 'testkit-core-and-store',
      comment: 'testkit 复用 store 的内存实现（不另写一份），其余只认 core',
      severity: 'error',
      from: { path: pkg('testkit') },
      to: { path: '^packages/(?!melon-core/|melon-store/|melon-testkit/)' },
    },
    {
      name: 'engine-core-and-skills',
      comment: '引擎只依赖契约与技能（调工具管线）；不认识模型、存储、审计的具体实现',
      severity: 'error',
      from: { path: pkg('engine') },
      to: { path: '^packages/(?!melon-core/|melon-skills/|melon-engine/)' },
    },

    // ── 包内目录之间 ──
    onlyCore('engine/task-pure', dir('engine', 'task'), dir('engine', 'task')),
    {
      name: 'engine/trigger-no-runtime',
      comment: '调度器不认识 AgentEngine（§4.8 边界一）—— 只依赖 core',
      severity: 'error',
      from: { path: dir('engine', 'trigger') },
      to: { path: ONLY_CORE, pathNot: dir('engine', 'trigger') },
    },
    onlyCore('skills/policy-pure', dir('skills', 'policy'), dir('skills', 'policy')),
    {
      name: 'llm/components-independent',
      comment: '路由、规划器、各供应商适配器互不认识，只通过 core 的端口相遇',
      severity: 'error',
      from: { path: '^packages/melon-llm/src/(router|planner|openai|anthropic)/' },
      to: { path: ONLY_CORE, pathNot: '^packages/melon-llm/src/$1/' },
    },

    {
      name: 'no-circular',
      comment: '不允许循环依赖',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(dist|node_modules|/test/)' },
    tsPreCompilationDeps: true,
    /**
     * 专用 tsconfig，把 `@melon-ai/*` 映射到各包的 **src**。
     *
     * 不这么做规则形同虚设：默认解析走 node_modules → pnpm 软链 → `dist/`，
     * 而 `dist` 在 exclude 里，跨包依赖整条被吃掉。
     * 构建仍然走 tsconfig.base.json（各包编译到 dist），这份只给 depcruise 用。
     */
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
  },
};
