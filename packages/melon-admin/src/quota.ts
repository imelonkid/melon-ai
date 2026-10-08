import type { AdminStore, QuotaPolicy, QuotaWindow, SpendDenial } from '@melon-ai/core';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 默认的时间窗：每天（北京时间 0 点清零）+ 滚动 5 小时。 */
export const DEFAULT_WINDOWS: readonly QuotaWindow[] = [
  { id: 'day', label: '今天', kind: 'day', tzOffsetMinutes: 480 },
  { id: '5h', label: '这 5 小时', kind: 'rolling', hours: 5 },
];

/** 一个时间窗现在的情况。 */
export interface WindowStatus {
  readonly id: string;
  readonly label: string;
  readonly kind: QuotaWindow['kind'];
  readonly used: number;
  /** 不限时没有。 */
  readonly limit?: number;
  /** 什么时候恢复（自然日 / 自然周：下一次 0 点清零；滚动：用量降到限额以下的时刻）。不限时没有。 */
  readonly resetAt?: number;
}

export interface QuotaStatus {
  readonly mode: QuotaPolicy['mode'];
  readonly unlimited: boolean;
  readonly windows: readonly WindowStatus[];
}

/** 额度用完时给用户的话。宿主可以换成自己的说法。 */
export type ReasonFn = (w: WindowStatus, ctx: { readonly currencySymbol: string; readonly tzOffsetMinutes: number }) => string;

export const SETTING_DEFAULT_AMOUNTS = 'quota.default';

const startOfDay = (now: number, tz: number) => {
  const off = tz * 60_000;
  return Math.floor((now + off) / DAY) * DAY - off;
};

/** 这一周的起点：本地时间这周 `startsOn`（0 = 周日）的 0 点。 */
const startOfWeek = (now: number, tz: number, startsOn = 1) => {
  const day0 = startOfDay(now, tz);
  const dow = new Date(day0 + tz * 60_000).getUTCDay();
  return day0 - ((dow - startsOn + 7) % 7) * DAY;
};

/** 时间窗现在从哪一刻算起、自然日 / 自然周的下一次清零。 */
function span(w: QuotaWindow, now: number): { from: number; next?: number } {
  if (w.kind === 'day') { const from = startOfDay(now, w.tzOffsetMinutes); return { from, next: from + DAY }; }
  if (w.kind === 'week') { const from = startOfWeek(now, w.tzOffsetMinutes, w.weekStartsOn); return { from, next: from + 7 * DAY }; }
  return { from: now - w.hours * HOUR };
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const clock = (t: number, tz: number) => {
  const d = new Date(t + tz * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

export const defaultReason: ReasonFn = (w, { currencySymbol, tzOffsetMinutes }) => {
  const amount = `${currencySymbol}${w.limit}`;
  if (w.kind === 'day') return `${w.label}的额度（${amount}）用完了，明天 0 点恢复。`;
  if (w.kind === 'week') return `${w.label}的额度（${amount}）用完了，下${WEEKDAY[new Date((w.resetAt ?? 0) + tzOffsetMinutes * 60_000).getUTCDay()]} 0 点恢复。`;
  return `${w.label}的额度（${amount}）用完了，${clock(w.resetAt ?? 0, tzOffsetMinutes)} 左右恢复。`;
};

export interface QuotaBookOptions {
  readonly store: AdminStore;
  readonly windows?: readonly QuotaWindow[];
  /** 没设过通用策略时的金额（按时间窗 id）。 */
  readonly defaults?: Readonly<Record<string, number>>;
  readonly now?: () => number;
  readonly currencySymbol?: string;
  readonly reason?: ReasonFn;
}

/**
 * 额度：通用策略（所有人默认）、单独策略、不限。只算 `counted` 的花费（哪些算由宿主定）。
 * 每次检查都读存储、不缓存 —— 管理员在后台或命令行改了立即生效（多个进程共用一个库也一样）。
 */
export class QuotaBook {
  readonly windows: readonly QuotaWindow[];
  private readonly store: AdminStore;
  private readonly defaults: Readonly<Record<string, number>>;
  private readonly now: () => number;
  readonly currencySymbol: string;
  private readonly reason: ReasonFn;

  constructor(o: QuotaBookOptions) {
    this.store = o.store;
    this.windows = o.windows ?? DEFAULT_WINDOWS;
    this.defaults = o.defaults ?? { day: 2, '5h': 0.8 };
    this.now = o.now ?? Date.now;
    this.currencySymbol = o.currencySymbol ?? '¥';
    this.reason = o.reason ?? defaultReason;
  }

  /** 通用策略的金额（每个时间窗一个）。 */
  async defaultAmounts(): Promise<Record<string, number>> {
    const saved = (await this.store.getSetting(SETTING_DEFAULT_AMOUNTS)) as Record<string, number> | undefined;
    return Object.fromEntries(this.windows.map((w) => [w.id, validAmount(saved?.[w.id]) ?? this.defaults[w.id] ?? 0]));
  }

  async setDefaultAmounts(amounts: Readonly<Record<string, number>>): Promise<Record<string, number>> {
    const cur = await this.defaultAmounts();
    const next = Object.fromEntries(this.windows.map((w) => [w.id, validAmount(amounts[w.id]) ?? cur[w.id] ?? 0]));
    await this.store.setSetting(SETTING_DEFAULT_AMOUNTS, next);
    return next;
  }

  async policy(principal: string): Promise<QuotaPolicy> {
    return (await this.store.getPolicy(principal)) ?? { mode: 'default' };
  }

  /** 改某人的策略。`custom` 的金额只留认识的时间窗、合法的数字。 */
  async setPolicy(principal: string, p: QuotaPolicy): Promise<QuotaPolicy> {
    if (p.mode === 'custom') {
      const amounts: Record<string, number> = {};
      for (const w of this.windows) { const a = validAmount(p.amounts?.[w.id]); if (a !== undefined) amounts[w.id] = a; }
      const next = { mode: 'custom' as const, amounts };
      await this.store.setPolicy(principal, next);
      return next;
    }
    await this.store.setPolicy(principal, p.mode === 'unlimited' ? { mode: 'unlimited' } : null);
    return { mode: p.mode === 'unlimited' ? 'unlimited' : 'default' };
  }

  /** 这个人各时间窗的限额；不限返回 null。 */
  async limits(principal: string): Promise<Record<string, number> | null> {
    const p = await this.policy(principal);
    if (p.mode === 'unlimited') return null;
    const def = await this.defaultAmounts();
    return Object.fromEntries(this.windows.map((w) => [w.id, p.mode === 'custom' ? (p.amounts?.[w.id] ?? def[w.id]!) : def[w.id]!]));
  }

  async status(principal: string): Promise<QuotaStatus> {
    const now = this.now();
    const p = await this.policy(principal);
    const lim = await this.limits(principal);
    const windows: WindowStatus[] = [];
    for (const w of this.windows) {
      const { from, next } = span(w, now);
      const used = await this.store.sumCounted(principal, from);
      if (!lim) { windows.push({ id: w.id, label: w.label, kind: w.kind, used }); continue; }
      const limit = lim[w.id]!;
      const resetAt = next ?? await this.rollingReset(principal, from, (w as { hours: number }).hours, limit, now);
      windows.push({ id: w.id, label: w.label, kind: w.kind, used, limit, resetAt });
    }
    return { mode: p.mode, unlimited: !lim, windows };
  }

  /** 滚动窗口：最早的几笔滑出去、用量降到限额以下的时刻。 */
  private async rollingReset(principal: string, from: number, hours: number, limit: number, now: number): Promise<number> {
    const rows = await this.store.listSpend({ principal, from, countedOnly: true });
    let total = rows.reduce((s, r) => s + r.amount, 0);
    for (const r of rows) {
      if (total < limit) break;
      total -= r.amount;
      if (total < limit) return r.at + hours * HOUR;
    }
    return now;
  }

  /** 花钱前的检查：哪个时间窗用完了就返回原因（几个都用完了，说最晚恢复的那个）。 */
  async check(principal: string): Promise<SpendDenial | null> {
    const s = await this.status(principal);
    if (s.unlimited) return null;
    const out = s.windows.filter((w) => w.limit !== undefined && w.used >= w.limit)
      .sort((a, b) => (b.resetAt ?? 0) - (a.resetAt ?? 0))[0];
    if (!out) return null;
    const tz = this.windows.find((w) => w.kind !== 'rolling') as { tzOffsetMinutes?: number } | undefined;
    return { reason: this.reason(out, { currencySymbol: this.currencySymbol, tzOffsetMinutes: tz?.tzOffsetMinutes ?? 480 }), ...(out.resetAt ? { resumeAt: out.resetAt } : {}) };
  }
}

function validAmount(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
}

export { startOfDay, startOfWeek };
