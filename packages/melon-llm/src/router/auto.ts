import type { CallMeta, ModelEntry, ModelTier, PlanPricing, RouteContext, UsageRecord } from '@melon-ai/core';
import { TIER_RANK } from '@melon-ai/core';
import { convert } from '../shared/money.js';
import type { FxRates } from '../shared/money.js';
import { costOf, isPeak } from './meter.js';
import type { HealthStats } from './meter.js';

/**
 * 自动路由：在「够档、能用」的模型里挑预估最便宜的。
 *
 * - 筛：已启用 → 已定档且不低于这类任务的最低档 → 要工具时只要支持工具的
 * - 排：预估花费低的优先 → 同价档次高的优先 → 再比平均耗时；没价格的排在有价格的后面；近期失败率超标的挪到最后
 * - 固定：宿主把某类任务固定给某个模型时，它排第一（不看档次），失败了照常换下一个
 *
 * 预估花费 = 这类任务的典型用量 × 这个模型此刻（分时段）的价格，缓存命中率取这个模型的实际值。
 */

/** 宿主的路由规则：这次调用属于哪类任务、最低要什么档、有没有固定的模型。 */
export interface RoutingRule {
  readonly taskClass: string;
  readonly minTier?: ModelTier;
  /** 固定的模型，`厂商/模型 id`（与用量账本的写法一致）。 */
  readonly pin?: string;
}
export type RoutingRules = (meta: CallMeta | undefined) => RoutingRule;

/** 模型的标识：`厂商/模型 id`。账本、固定、解释里都用它。 */
export const modelKey = (e: ModelEntry): string => `${e.egress}/${e.model.id}`;

/** 典型用量的初始值：这类任务还没跑够 5 次时用。 */
export const DEFAULT_TYPICAL = { inputTokens: 4000, outputTokens: 600 } as const;

const WEEK = 7 * 86_400_000;

/**
 * 近 7 天的实际用量：每类任务的典型输入 / 输出，每个模型的缓存命中率与平均耗时。
 * 内存里维护，启动时用账本预热，之后每次记账顺带更新 —— 选模型时不去读库。
 */
export class UsageStats {
  private rows: { at: number; taskClass: string; model: string; ok: boolean; in: number; cached: number; out: number; ms: number }[] = [];

  constructor(private readonly now: () => number = () => Date.now(), private readonly minSamples = 5) {}

  /** 路由规则换了（任务类别的分法变了）时清空，再按新规则从账本重新预热。 */
  clear(): void {
    this.rows = [];
  }

  record(r: UsageRecord, taskClass: string): void {
    // 汇总行（calls > 1）只给用量页看；这里要的是单次调用的典型值
    if (r.calls !== 1) return;
    this.rows.push({
      at: r.at, taskClass, model: `${r.egress}/${r.model}`, ok: r.ok,
      in: r.inputTokens, cached: r.cachedInputTokens, out: r.outputTokens, ms: r.ms,
    });
    const since = this.now() - WEEK;
    if (this.rows.length > 5000 || (this.rows[0] && this.rows[0].at < since)) this.rows = this.rows.filter((x) => x.at >= since).slice(-5000);
  }

  private recent(): typeof this.rows {
    const since = this.now() - WEEK;
    return this.rows.filter((x) => x.at >= since && x.ok);
  }

  typical(taskClass: string): { inputTokens: number; outputTokens: number; samples: number } {
    const xs = this.recent().filter((x) => x.taskClass === taskClass);
    if (xs.length < this.minSamples) return { ...DEFAULT_TYPICAL, samples: xs.length };
    return {
      inputTokens: Math.round(xs.reduce((a, x) => a + x.in, 0) / xs.length),
      outputTokens: Math.round(xs.reduce((a, x) => a + x.out, 0) / xs.length),
      samples: xs.length,
    };
  }

  cacheRate(model: string): number {
    const xs = this.recent().filter((x) => x.model === model);
    const input = xs.reduce((a, x) => a + x.in, 0);
    return input > 0 ? xs.reduce((a, x) => a + x.cached, 0) / input : 0;
  }

  avgMs(model: string): number | null {
    const xs = this.recent().filter((x) => x.model === model);
    return xs.length ? xs.reduce((a, x) => a + x.ms, 0) / xs.length : null;
  }
}

/**
 * 套餐额度：按厂商（`egress`）数近一段时间成功的请求。套餐的额度是整个账号共用的，不分模型。
 * 只在内存里；启动时用账本预热（最长的窗口一般是一个月）。
 */
export class QuotaCounter {
  private readonly log = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => Date.now(), private readonly keepHours = 24 * 31) {}

  add(egress: string, at: number): void {
    const list = this.log.get(egress) ?? [];
    list.push(at);
    // 偶尔清掉一个月以前的
    if (list.length % 500 === 0) {
      const since = this.now() - this.keepHours * 3_600_000;
      this.log.set(egress, list.filter((x) => x >= since));
    } else this.log.set(egress, list);
  }

  /** 每个窗口用了多少：`[{ hours, used, limit }]`。 */
  usage(egress: string, quotas: PlanPricing['quotas']): { hours: number; used: number; limit: number }[] {
    const list = this.log.get(egress) ?? [];
    const now = this.now();
    return quotas.map((q) => ({ hours: q.hours, limit: q.requests, used: list.filter((x) => x > now - q.hours * 3_600_000).length }));
  }
}

/** 额度用到这个比例就让位：别等撞上限、请求失败了才换。 */
export const PLAN_YIELD_AT = 0.95;

/** 一个候选为什么能用 / 不能用、预估多少钱。给宿主的路由页解释「为什么选它」。 */
export interface RouteCandidate {
  readonly key: string;
  readonly label: string;
  readonly tier?: ModelTier;
  readonly eligible: boolean;
  /** 不参与的原因：未启用、未定档、档次不够、不支持工具。 */
  readonly reason?: string;
  readonly pinned: boolean;
  readonly demoted: boolean;
  /** 预估每次的花费（按模型的币种）；没价格时没有。 */
  readonly estimate?: { readonly amount: number; readonly currency: 'CNY' | 'USD' };
  readonly peak: boolean;
  /** 走套餐：各窗口的用量；`nearQuota` 表示有一个窗口快满了（排到后面）。 */
  readonly plan?: { readonly name?: string; readonly windows: readonly { hours: number; used: number; limit: number }[]; readonly nearQuota: boolean };
}

export interface RouteExplanation {
  readonly taskClass: string;
  readonly minTier?: ModelTier;
  readonly typical: { readonly inputTokens: number; readonly outputTokens: number; readonly samples: number };
  /** 按优先级排好：第一个就是现在会用的。 */
  readonly ranked: readonly RouteCandidate[];
  /** 没有一个够档的模型时为 true：退回到全部可用的模型里挑（不让任务直接失败）。 */
  readonly fellBack: boolean;
}

export interface AutoRankInput {
  readonly entries: readonly ModelEntry[];
  readonly rule: RoutingRule;
  readonly ctx?: RouteContext;
  readonly stats: UsageStats;
  readonly health: HealthStats;
  readonly quota?: QuotaCounter;
  readonly now: number;
  readonly fx?: FxRates;
}

export function rankAuto(i: AutoRankInput): { readonly ranked: readonly ModelEntry[]; readonly explanation: RouteExplanation } {
  const { rule } = i;
  const typical = i.stats.typical(rule.taskClass);
  const min = rule.minTier ? TIER_RANK[rule.minTier] : 1;

  const judge = (e: ModelEntry): RouteCandidate & { entry: ModelEntry; usd: number | null; ms: number } => {
    const key = modelKey(e);
    const pinned = rule.pin === key;
    let reason: string | undefined;
    if (e.enabled === false) reason = '未启用';
    else if (i.ctx?.needsTools && !e.model.capabilities.tools) reason = '不支持工具';
    else if (!pinned && !e.tier) reason = '未定档';
    else if (!pinned && TIER_RANK[e.tier!] < min) reason = '档次不够';
    const cache = i.stats.cacheRate(key);
    // 套餐：按次不另计，预估 0 —— 够档时优先用；额度快满时让位
    const windows = e.plan && i.quota ? i.quota.usage(e.egress, e.plan.quotas) : [];
    const nearQuota = windows.some((w) => w.limit > 0 && w.used / w.limit >= PLAN_YIELD_AT);
    const amount = e.plan ? 0 : e.price
      ? costOf(e.price, { inputTokens: typical.inputTokens, cachedInputTokens: Math.round(typical.inputTokens * cache), outputTokens: typical.outputTokens }, i.now)
      : null;
    const cur = e.plan?.currency ?? e.price?.currency;
    return {
      entry: e, key, label: e.label ?? e.egress, ...(e.tier ? { tier: e.tier } : {}),
      eligible: reason === undefined, ...(reason ? { reason } : {}),
      pinned, demoted: i.health.demoted(e.model.id) || nearQuota,
      ...(amount !== null && cur ? { estimate: { amount, currency: cur } } : {}),
      peak: !e.plan && !!e.price && isPeak(e.price, i.now),
      ...(e.plan ? { plan: { ...(e.plan.name ? { name: e.plan.name } : {}), windows, nearQuota } } : {}),
      usd: amount !== null && cur ? convert(amount, cur, 'USD', i.fx) : null,
      ms: i.stats.avgMs(key) ?? Number.POSITIVE_INFINITY,
    };
  };

  const all = i.entries.map(judge);
  let pool = all.filter((c) => c.eligible);
  // 一个够档的都没有（都没定档、档次都不够）：退回到能用的里挑，不让任务直接失败 —— 路由页会把这个情况标出来
  const fellBack = pool.length === 0;
  if (fellBack) pool = all.filter((c) => c.entry.enabled !== false && !(i.ctx?.needsTools && !c.entry.model.capabilities.tools));

  const order = (a: (typeof all)[number], b: (typeof all)[number]): number => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
    // 有价格的在前：没价格的不知道贵不贵，不该凭空排到便宜的前面
    if ((a.usd === null) !== (b.usd === null)) return a.usd === null ? 1 : -1;
    if (a.usd !== null && b.usd !== null && Math.abs(a.usd - b.usd) > 1e-12) return a.usd - b.usd;
    const ta = a.entry.tier ? TIER_RANK[a.entry.tier] : 0;
    const tb = b.entry.tier ? TIER_RANK[b.entry.tier] : 0;
    if (ta !== tb) return tb - ta;
    return a.ms - b.ms;
  };
  pool.sort(order);
  const rest = all.filter((c) => !pool.includes(c));
  const strip = ({ entry: _e, usd: _u, ms: _m, ...c }: (typeof all)[number]): RouteCandidate => c;
  return {
    ranked: pool.map((c) => c.entry),
    explanation: {
      taskClass: rule.taskClass, ...(rule.minTier ? { minTier: rule.minTier } : {}), typical,
      ranked: [...pool.map(strip), ...rest.map(strip)],
      fellBack,
    },
  };
}
