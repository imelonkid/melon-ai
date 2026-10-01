import type { Currency, UsageRecord } from '@melon-ai/core';
import { convert } from './meter.js';
import type { FxRates } from './meter.js';

/**
 * 用量汇总：账本里的明细 → 宿主画图、出报表要的数。
 *
 * 纯函数，任何宿主同一个口径：费用统一折成 `currency`；没价格的调用单独数（`unpricedCalls`），不算进费用。
 */

export interface UsageTotals {
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** 折成 `currency` 的费用。 */
  readonly cost: number;
  /** 没有价格的调用次数：费用里没算它们。 */
  readonly unpricedCalls: number;
  readonly ms: number;
}

export interface UsageGroup extends UsageTotals {
  readonly key: string;
}

export interface UsageBucket extends UsageTotals {
  /** 这一格的开始时间（按 `timeZone` 的整点或零点）。 */
  readonly start: number;
  /** 这一格里按模型（`厂商/模型`）分的费用与次数，画堆叠图用。 */
  readonly byModel: readonly UsageGroup[];
}

export interface UsageSummary extends UsageTotals {
  readonly from: number;
  readonly to: number;
  readonly currency: Currency;
  readonly bucket: 'hour' | 'day';
  /** 输入里命中缓存的比例；没有输入时为 null。 */
  readonly cacheHitRate: number | null;
  readonly buckets: readonly UsageBucket[];
  /** 按维度分组，按费用从高到低（费用相同按次数）。`model` 的 key 是 `厂商/模型`。 */
  readonly groups: {
    readonly model: readonly UsageGroup[];
    readonly egress: readonly UsageGroup[];
    readonly taskKind: readonly UsageGroup[];
    readonly trigger: readonly UsageGroup[];
    readonly purpose: readonly UsageGroup[];
  };
}

export interface SummaryOptions {
  readonly from: number;
  readonly to: number;
  readonly bucket?: 'hour' | 'day';
  /** 分桶用的时区（IANA）。默认运行环境的时区。 */
  readonly timeZone?: string;
  /** 费用折成什么币种。默认 CNY。 */
  readonly currency?: Currency;
  readonly fx?: FxRates;
}

const ZERO: UsageTotals = { calls: 0, failed: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0, unpricedCalls: 0, ms: 0 };

function add(t: UsageTotals, r: UsageRecord, cost: number): UsageTotals {
  return {
    calls: t.calls + r.calls,
    failed: t.failed + (r.ok ? 0 : r.calls),
    inputTokens: t.inputTokens + r.inputTokens,
    cachedInputTokens: t.cachedInputTokens + r.cachedInputTokens,
    outputTokens: t.outputTokens + r.outputTokens,
    cost: t.cost + cost,
    unpricedCalls: t.unpricedCalls + (r.priced ? 0 : r.calls),
    ms: t.ms + r.ms,
  };
}

/** 本地时间的整点 / 零点。 */
function floorLocal(at: number, bucket: 'hour' | 'day', timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  const into = (bucket === 'day' ? n('hour') * 3600 : 0) + n('minute') * 60 + n('second');
  return at - into * 1000 - (at % 1000);
}

function grouped(map: Map<string, UsageTotals>): UsageGroup[] {
  return [...map.entries()].map(([key, t]) => ({ key, ...t })).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
}

export function summarizeUsage(records: readonly UsageRecord[], o: SummaryOptions): UsageSummary {
  const bucket = o.bucket ?? 'hour';
  const tz = o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currency = o.currency ?? 'CNY';
  const step = bucket === 'hour' ? 3_600_000 : 86_400_000;

  // 先把范围内的每一格都列出来（空的也要，图上才有零）
  const cells = new Map<number, { totals: UsageTotals; byModel: Map<string, UsageTotals> }>();
  // 按天时多走两小时再取零点：夏令时那天只有 23 或 25 小时，直接加 24 小时会落在同一天或跳过一天
  const next = (s: number) => floorLocal(s + step + (bucket === 'day' ? 7_200_000 : 0), bucket, tz);
  for (let s = floorLocal(o.from, bucket, tz); s < o.to; s = next(s)) {
    cells.set(s, { totals: ZERO, byModel: new Map() });
    if (cells.size > 2000) break;
  }

  let total = ZERO;
  const dims = { model: new Map<string, UsageTotals>(), egress: new Map(), taskKind: new Map(), trigger: new Map(), purpose: new Map() } as
    Record<keyof UsageSummary['groups'], Map<string, UsageTotals>>;
  for (const r of records) {
    if (r.at < o.from || r.at >= o.to) continue;
    const cost = r.priced ? convert(r.cost, r.currency, currency, o.fx) : 0;
    total = add(total, r, cost);
    const modelKey = `${r.egress}/${r.model}`;
    const keys: Record<keyof UsageSummary['groups'], string> = {
      model: modelKey, egress: r.egress, taskKind: r.taskKind ?? '', trigger: r.trigger ?? '', purpose: r.purpose,
    };
    for (const d of Object.keys(dims) as (keyof typeof dims)[]) dims[d].set(keys[d], add(dims[d].get(keys[d]) ?? ZERO, r, cost));
    const cell = cells.get(floorLocal(r.at, bucket, tz));
    if (cell) {
      cell.totals = add(cell.totals, r, cost);
      cell.byModel.set(modelKey, add(cell.byModel.get(modelKey) ?? ZERO, r, cost));
    }
  }

  return {
    ...total,
    from: o.from, to: o.to, currency, bucket,
    cacheHitRate: total.inputTokens > 0 ? total.cachedInputTokens / total.inputTokens : null,
    buckets: [...cells.entries()].sort((a, b) => a[0] - b[0])
      .map(([start, c]) => ({ start, ...c.totals, byModel: grouped(c.byModel) })),
    groups: {
      model: grouped(dims.model), egress: grouped(dims.egress), taskKind: grouped(dims.taskKind),
      trigger: grouped(dims.trigger), purpose: grouped(dims.purpose),
    },
  };
}
