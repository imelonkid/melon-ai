/**
 * 网页搜索协议。
 *
 * 搜索不像模型那样有事实上的通用线协议（OpenAI 兼容），各家接口各不相同。
 * 所以引擎只定这份约定：技能（`@melon-ai/skills/web`）只认它，
 * 具体厂商（博查、Tavily……）的实现放在 `@melon-ai/plugins` 的子路径里，宿主按需引入。
 */

/** 一条搜索结果。字段取各家搜索服务的公约数。 */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly site: string;
  /** YYYY-MM-DD；拿不到时为空串 */
  readonly date: string;
}

/** 时间范围。各家实现在自己内部映射到厂商的取值。 */
export type Freshness = 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';
export const FRESHNESS: readonly Freshness[] = ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'];

export interface SearchQuery {
  readonly query: string;
  readonly freshness: Freshness;
  /** 1–10，技能已经夹过范围 */
  readonly count: number;
}

/**
 * 搜索服务。实现方的约定：
 * - 失败抛 `ToolError`，按性质给码：key 无效 `DENIED`（重试没用）、限流 `RATE_LIMITED`、
 *   其余 `UPSTREAM` —— 管线据此决定重不重试。
 * - 尊重 `signal`（超时由技能统一控制）。
 * - 返回的内容**不需要**自己做不可信标记，技能统一处理。
 */
export interface SearchProvider {
  /** 稳定标识，如 'bocha'。换 key 不变，换厂商才变。 */
  readonly id: string;
  /** 给人看的名字，如「博查」。 */
  readonly label?: string;
  search(q: SearchQuery, signal: AbortSignal): Promise<readonly SearchHit[]>;
}
