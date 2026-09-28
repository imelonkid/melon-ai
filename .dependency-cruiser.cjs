/**
 * 依赖方向的强制规则。
 * 分层约定光写在文档里没用 —— 这份配置在 CI 里跑，破坏分层会直接挂。
 * 详见 docs/architecture.md §4.3
 *
 * ⚠️ 关键点：规则必须排除**包内**导入。
 * 早期版本只用路径正则，结果 melon-store-sqlite 内部文件互相 import 时
 * 同时匹配了 from 与 to，被误报成「适配器之间互相依赖」。
 * 用捕获组 + `pathNot: '^packages/$1/'` 把同包导入排除掉。
 */
// 显式枚举，不用嵌套可选组 —— dependency-cruiser 会把后者判为不安全正则
const ADAPTER_PKGS = ['melon-store-sqlite', 'melon-llm-anthropic', 'melon-llm-openai', 'melon-mcp'];
const DOMAIN_PKGS = [
  'melon-task', 'melon-tools', 'melon-skills', 'melon-skills-builtin',
  'melon-memory', 'melon-context', 'melon-policy', 'melon-router',
  'melon-prompt', 'melon-audit', 'melon-planner-react',
];
const group = (names) => `^packages/(${names.join('|')})/`;
const ADAPTER_PKG = group(ADAPTER_PKGS);
const DOMAIN_PKG = group(DOMAIN_PKGS);
const ADAPTER_ANY = `^packages/(?:${ADAPTER_PKGS.join('|')})/`;

module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: '@melon-ai/core 是倒置中心，不能依赖任何其他包',
      severity: 'error',
      from: { path: '^packages/melon-core/' },
      to: { path: '^packages/(?!melon-core/)' },
    },
    {
      name: 'domain-no-infra',
      comment: '领域层只能依赖端口，不能依赖任何适配器实现',
      severity: 'error',
      from: { path: DOMAIN_PKG },
      to: { path: ADAPTER_ANY, pathNot: '^packages/$1/' },
    },
    {
      name: 'infra-only-core',
      comment: '适配器只依赖 @melon-ai/core，不依赖领域层（包内导入除外）',
      severity: 'error',
      from: { path: ADAPTER_PKG },
      to: { path: '^packages/(?!melon-core/)', pathNot: '^packages/$1/' },
    },
    {
      name: 'no-adapter-to-adapter',
      comment: '适配器之间互不认识（包内导入除外）',
      severity: 'error',
      from: { path: ADAPTER_PKG },
      to: { path: ADAPTER_ANY, pathNot: '^packages/$1/' },
    },
    {
      name: 'no-circular',
      comment: '包之间不允许循环依赖',
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
