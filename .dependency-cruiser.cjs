/**
 * 依赖方向的强制规则。
 * 分层约定光写在文档里没用 —— 这份配置在 CI 里跑，破坏分层会直接挂。
 * 详见 docs/architecture.md §4.3
 */
const ADAPTER = '^packages/melon-(store|llm|mcp)-';
const DOMAIN = '^packages/melon-(task|tools|skills|memory|context|policy)(/|$)';

module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: '@melon-ai/core 是倒置中心，不能依赖任何其他包',
      severity: 'error',
      from: { path: '^packages/melon-core' },
      to: { path: '^packages/(?!melon-core)' },
    },
    {
      name: 'domain-no-infra',
      comment: '领域层只能依赖端口，不能依赖任何适配器实现',
      severity: 'error',
      from: { path: DOMAIN },
      to: { path: ADAPTER },
    },
    {
      name: 'infra-only-core',
      comment: '适配器只依赖 @melon-ai/core，不依赖领域层',
      severity: 'error',
      from: { path: ADAPTER },
      to: { path: '^packages/(?!melon-core)' },
    },
    {
      name: 'no-adapter-to-adapter',
      comment: '适配器之间互不认识',
      severity: 'error',
      from: { path: ADAPTER },
      to: { path: ADAPTER },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(dist|node_modules|/test/)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};
