import type { QuotaSnapshot } from '@melon-ai/core';

export interface QuotaVerdict {
  readonly ok: boolean;
  readonly reason?: string;
  readonly which?: 'cost' | 'calls';
}

/** 配额检查。null 表示不限。 */
export function checkQuota(q: QuotaSnapshot | null): QuotaVerdict {
  if (!q) return { ok: true };
  if (q.usedUSD >= q.limitUSD) {
    return { ok: false, which: 'cost', reason: `${q.window} 费用配额已用尽（${q.usedUSD}/${q.limitUSD}）` };
  }
  if (q.usedCalls >= q.limitCalls) {
    return { ok: false, which: 'calls', reason: `${q.window} 调用次数配额已用尽（${q.usedCalls}/${q.limitCalls}）` };
  }
  return { ok: true };
}

export const quotaPct = (q: QuotaSnapshot): number =>
  Math.max(q.usedUSD / (q.limitUSD || 1), q.usedCalls / (q.limitCalls || 1));
