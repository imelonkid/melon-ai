/**
 * `@melon-ai/agent/web` —— 联网技能（Node 宿主）。
 *
 * ```ts
 * import { web, bocha } from '@melon-ai/agent/web';
 * const agent = await createAgent({ skills: [web({ search: bocha({ apiKey }) })], ... });
 * // 换 key 或停用：agent.configure({ skills: [web({ search: null })] })
 * ```
 *
 * 搜索结果与网页正文都是不可信内容：读过它们的任务，之后的对外操作一律要人确认。
 */
export {
  web, bocha, WebSkillProvider, WEB_SEARCH, WEB_FETCH, FRESHNESS, isPrivateAddress, fetchPage, htmlToText,
} from '@melon-ai/skills/web';
export type {
  WebSkillOptions, SearchBackend, SearchHit, SearchQuery, Freshness, BochaOptions, FetchOptions, Lookup, Page,
} from '@melon-ai/skills/web';
