/**
 * `@melon-ai/agent/web` —— 联网技能（Node 宿主）。
 *
 * 搜索服务是可插拔的：技能只认 core 的 `SearchProvider` 协议，
 * 厂商实现从扩展包按需引入（`@melon-ai/plugins/bocha`），也可以宿主自己实现。
 *
 * ```ts
 * import { web, testSearch } from '@melon-ai/agent/web';
 * import { bocha } from '@melon-ai/plugins/bocha';
 * const agent = await createAgent({ skills: [web({ search: bocha({ apiKey }) })], ... });
 * // 换 key 或停用：agent.configure({ skills: [web({ search: null })] })
 * ```
 *
 * 搜索结果与网页正文都是不可信内容：读过它们的任务，之后的对外操作一律要人确认。
 */
export {
  web, testSearch, WebSkillProvider, WEB_SEARCH, WEB_FETCH, FRESHNESS, isPrivateAddress, fetchPage, htmlToText,
} from '@melon-ai/skills/web';
export type {
  WebSkillOptions, SearchProvider, SearchHit, SearchQuery, SearchTestResult, Freshness, FetchOptions, Lookup, Page,
} from '@melon-ai/skills/web';
