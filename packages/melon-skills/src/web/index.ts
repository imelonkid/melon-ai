/**
 * `@melon-ai/skills/web` —— 联网技能：网页搜索（后端可换，一期博查）与读网页正文。
 *
 * 单独一个子路径：读网页用 Node 的 DNS 解析做内网拦截，只适用于 Node 宿主
 * （其他宿主可注入 `lookup`）。技能包的根入口因此保持与运行时无关。
 * 两个工具都声明 `untrustedOutput`，读过它们的任务之后的对外操作一律要人确认。
 */
export * from './search.js';
export * from './fetch.js';
export * from './provider.js';
