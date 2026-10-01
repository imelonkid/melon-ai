import type { UsageRecord } from '@melon-ai/core';

const DAY = 86_400_000;

/**
 * 把明细按天、按维度汇总。两种存储共用，保证汇总口径一致。
 *
 * 汇总后丢掉任务 id 与尝试序号，其余维度（模型、厂商、任务类型、成功与否、失败原因）都留着 ——
 * 看趋势够用；要追某一次调用，得在保留期内看明细。
 */
export function rollupRecords(details: readonly UsageRecord[]): UsageRecord[] {
  const groups = new Map<string, UsageRecord>();
  for (const r of details) {
    const day = Math.floor(r.at / DAY) * DAY;
    const key = JSON.stringify([day, r.agentId, r.taskKind, r.trigger, r.purpose, r.egress, r.model, r.ok, r.errorCode, r.currency, r.priced, r.billing]);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        at: day, calls: r.calls, purpose: r.purpose, egress: r.egress, model: r.model, ok: r.ok,
        ...(r.agentId !== undefined ? { agentId: r.agentId } : {}),
        ...(r.taskKind !== undefined ? { taskKind: r.taskKind } : {}),
        ...(r.trigger !== undefined ? { trigger: r.trigger } : {}),
        ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
        ...(r.billing ? { billing: r.billing } : {}),
        inputTokens: r.inputTokens, cachedInputTokens: r.cachedInputTokens, outputTokens: r.outputTokens,
        cost: r.cost, currency: r.currency, priced: r.priced, ms: r.ms,
      });
    } else {
      groups.set(key, {
        ...g,
        calls: g.calls + r.calls,
        inputTokens: g.inputTokens + r.inputTokens,
        cachedInputTokens: g.cachedInputTokens + r.cachedInputTokens,
        outputTokens: g.outputTokens + r.outputTokens,
        cost: g.cost + r.cost,
        ms: g.ms + r.ms,
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.at - b.at);
}

