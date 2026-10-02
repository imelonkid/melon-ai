import type {
  CallMeta, ChatModel, GenerateRequest, GenerateResult, ModelCapabilities, ModelEntry, ModelPrice,
  UsageLedger, UsageRecord,
} from '@melon-ai/core';
import { convert } from '../shared/money.js';
import type { FxRates } from '../shared/money.js';

export { DEFAULT_FX, convert } from '../shared/money.js';
export type { FxRates } from '../shared/money.js';

/**
 * 计量与换模型：每次问模型都记一笔账；失败了换下一个候选。
 *
 * 放在路由层而不是规划器：任何地方问模型（规划、分类、以后的摘要）都要记账、都该能换 ——
 * 规划器只管「问什么」，不该每处调用各写一遍重试和计费。
 */

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** `at` 时刻是不是高峰时段（按价格里给的时区）。 */
export function isPeak(price: ModelPrice, at: number): boolean {
  const p = price.peak;
  if (!p) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: p.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  const day = WEEKDAY[get('weekday')] ?? 0;
  const hm = `${get('hour')}:${get('minute')}`;
  return p.windows.some((w) => w.days.includes(day) && hm >= w.from && hm < w.to);
}

/** 这次调用的费用（按价格的币种）。输入里命中缓存的部分按缓存价，其余按输入价。 */
export function costOf(
  price: ModelPrice, u: { inputTokens: number; cachedInputTokens?: number; outputTokens: number }, at: number,
): number {
  const k = isPeak(price, at) ? price.peak!.multiplier : 1;
  const cached = Math.min(u.cachedInputTokens ?? 0, u.inputTokens);
  return k * ((u.inputTokens - cached) * price.input + cached * (price.cachedInput ?? price.input) + u.outputTokens * price.output) / 1_000_000;
}


/**
 * 各模型近一段时间的成败。失败率高的排到候选最后（不剔除 —— 全都在出错时宁可试一个）。
 * 只在内存里；启动时由宿主用账本里最近一小时的记录 `seed`，重启不会把出错的模型当成好的。
 */
export class HealthStats {
  private readonly log = new Map<string, { at: number; ok: boolean }[]>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    readonly windowMs = 3_600_000,
    /** 样本少于这个数不判：一次超时不该让一个模型被降权一小时。 */
    readonly minCalls = 5,
    readonly maxFailureRate = 0.2,
  ) {}

  record(model: string, ok: boolean, at = this.now()): void {
    const list = this.log.get(model) ?? [];
    list.push({ at, ok });
    this.log.set(model, list.filter((x) => x.at > at - this.windowMs));
  }

  seed(records: readonly UsageRecord[]): void {
    for (const r of records) this.record(r.model, r.ok, r.at);
  }

  stats(model: string): { calls: number; failed: number } {
    const since = this.now() - this.windowMs;
    const list = (this.log.get(model) ?? []).filter((x) => x.at > since);
    return { calls: list.length, failed: list.filter((x) => !x.ok).length };
  }

  /** 失败率超标：排到后面。 */
  demoted(model: string): boolean {
    const s = this.stats(model);
    return s.calls >= this.minCalls && s.failed / s.calls > this.maxFailureRate;
  }
}

import { isAccountError } from '../shared/account.js';
export { isAccountError };

/** 一家暂停多久：余额不足的人多半要过一会儿才去充值；到期后再试一次。 */
const ACCOUNT_PAUSE_MS = 30 * 60_000;

export interface AccountProblem {
  readonly egress: string;
  readonly reason: 'billing' | 'auth';
  /** 厂商原话（宿主给用户看）。 */
  readonly message: string;
  readonly since: number;
  /** 到这个时间再试。 */
  readonly until: number;
}

/**
 * 各家账户的状态：余额不足、key 失效的那家暂停使用（排序时跳过，除非只剩它），到期或宿主清除后恢复。
 * 按厂商（egress）记 —— 同一个账户下的所有模型一起。
 */
export class AccountStatus {
  private readonly problems = new Map<string, AccountProblem>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  mark(egress: string, reason: 'billing' | 'auth', message: string): void {
    const at = this.now();
    this.problems.set(egress, { egress, reason, message: message.slice(0, 300), since: this.problems.get(egress)?.since ?? at, until: at + ACCOUNT_PAUSE_MS });
  }

  clear(egress?: string): void {
    if (egress === undefined) this.problems.clear();
    else this.problems.delete(egress);
  }

  down(egress: string): boolean {
    const p = this.problems.get(egress);
    if (!p) return false;
    if (p.until <= this.now()) { this.problems.delete(egress); return false; }
    return true;
  }

  list(): readonly AccountProblem[] {
    return [...this.problems.values()].filter((p) => this.down(p.egress));
  }
}

export interface MeterOptions {
  /** 账户状态：余额不足、key 失效的记在这里，同一家的其余候选不再试。 */
  readonly accounts?: AccountStatus;
  readonly ledger?: UsageLedger;
  readonly health: HealthStats;
  readonly now: () => number;
  readonly fx?: FxRates;
  /** 一次调用最多试几个模型（含首选）。 */
  readonly maxAttempts: number;
  /** 账本写失败只记一下，不影响这次调用。 */
  readonly onLedgerError?: (e: unknown) => void;
  /** 每记一笔回调一次（路由的用量统计据此更新）。没有账本也会回调。 */
  readonly onRecord?: (r: UsageRecord) => void;
}

const errCode = (e: unknown): string => (e as { code?: string })?.code ?? 'ERROR';

/**
 * 依次试候选模型，直到有一个答上来。对外就是一个 `ChatModel`，规划器不必知道换过模型。
 *
 * 什么错都换（鉴权失败、请求被拒、上游出错、限流、超时）：别家有别家的 key 和参数限制，
 * 这家不认的请求换一家可能就过了。只有调用方主动取消时不换。
 */
export class FailoverModel implements ChatModel {
  readonly id: string;
  readonly capabilities: ModelCapabilities;

  constructor(private readonly candidates: readonly ModelEntry[], private readonly opts: MeterOptions) {
    if (candidates.length === 0) throw new Error('FailoverModel 至少需要一个候选');
    this.id = candidates[0]!.model.id;
    this.capabilities = candidates[0]!.model.capabilities;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const max = Math.max(1, this.opts.maxAttempts);
    const failed: { egress: string; model: string; errorCode: string }[] = [];
    // 账户出了问题的厂商（余额不足、key 失效）：它的其余模型不再试，名额留给别家
    const deadVendors = new Set<string>();
    const tries = this.candidates;
    let attempt = 0;
    let last: unknown;
    for (let i = 0; i < tries.length && attempt < max; i++) {
      const entry = tries[i]!;
      if (deadVendors.has(entry.egress)) continue;
      attempt += 1;
      if (attempt > 1) req.onRetry?.();
      const started = this.opts.now();
      try {
        const res = await entry.model.generate(req);
        const at = this.opts.now();
        // 套餐内按次不另计：费用 0，记账时标出来（用量页按套餐单独显示）
        const cost = entry.plan ? 0 : entry.price ? costOf(entry.price, res.usage, at) : undefined;
        const currency = entry.plan?.currency ?? entry.price?.currency;
        const usage = {
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          ...(res.usage.cachedInputTokens !== undefined ? { cachedInputTokens: res.usage.cachedInputTokens } : {}),
          // 费用只按配置的价格算；没有价格就不报，不用适配器里的粗估
          ...(currency && cost !== undefined
            ? { cost: { amount: cost, currency }, costUSD: convert(cost, currency, 'USD', this.opts.fx) }
            : {}),
        };
        this.opts.health.record(entry.model.id, true, at);
        // 答上来了：这家的账户没问题（充过值了）
        this.opts.accounts?.clear(entry.egress);
        await this.book(req.meta, entry, attempt, { ok: true, usage: { ...usage, modelId: res.modelId }, at, ms: at - started });
        return { ...res, usage, egress: entry.egress, ...(failed.length ? { failedAttempts: failed } : {}) };
      } catch (e) {
        const at = this.opts.now();
        this.opts.health.record(entry.model.id, false, at);
        await this.book(req.meta, entry, attempt, { ok: false, errorCode: errCode(e), at, ms: at - started });
        if (req.signal?.aborted) throw e;
        const account = isAccountError(e);
        if (account) {
          deadVendors.add(entry.egress);
          this.opts.accounts?.mark(entry.egress, account, e instanceof Error ? e.message : String(e));
        }
        last = e;
        failed.push({ egress: entry.egress, model: entry.model.id, errorCode: errCode(e) });
      }
    }
    throw last ?? new Error('没有可用的模型');
  }

  private async book(
    meta: CallMeta | undefined, entry: ModelEntry, attempt: number,
    r: {
      ok: boolean; errorCode?: string; at: number; ms: number;
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cost?: { amount: number }; modelId: string };
    },
  ): Promise<void> {
    // 没说为谁问的调用（连接测试等）不进账本
    if (!meta) return;
    const rec: UsageRecord = {
      at: r.at, calls: 1, purpose: meta.purpose, egress: entry.egress, model: r.usage?.modelId ?? entry.model.id,
      ok: r.ok, attempt, ms: r.ms,
      ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
      ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
      ...(meta.taskKind !== undefined ? { taskKind: meta.taskKind } : {}),
      ...(meta.trigger !== undefined ? { trigger: meta.trigger } : {}),
      ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
      inputTokens: r.usage?.inputTokens ?? 0,
      cachedInputTokens: r.usage?.cachedInputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      cost: r.usage?.cost?.amount ?? 0,
      currency: entry.plan?.currency ?? entry.price?.currency ?? 'USD',
      priced: !!entry.price || !!entry.plan,
      ...(entry.plan ? { billing: 'plan' as const } : {}),
    };
    this.opts.onRecord?.(rec);
    if (!this.opts.ledger) return;
    try { await this.opts.ledger.record(rec); } catch (e) { this.opts.onLedgerError?.(e); }
  }
}
