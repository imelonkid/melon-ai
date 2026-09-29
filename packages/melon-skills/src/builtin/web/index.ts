/**
 * `@melon-ai/skills/web` —— 联网技能：网页搜索与读网页正文。
 *
 * 搜索只认 core 的 `SearchProvider` 协议；博查等厂商实现在 `@melon-ai/plugins`，宿主按需引入。
 *
 * 单独一个子路径：读网页用 Node 的 DNS 解析做内网拦截，只适用于 Node 宿主
 * （其他宿主可注入 `lookup`）。技能包的根入口因此保持与运行时无关。
 * 两个工具都声明 `untrustedOutput`，读过它们的任务之后的对外操作一律要人确认。
 */
export * from './search.js';
export * from './fetch.js';
export * from './provider.js';
export type { Freshness, SearchHit, SearchProvider, SearchQuery } from '@melon-ai/core';
export { FRESHNESS } from '@melon-ai/core';
