import type { Currency, PriceStore, PriceSync, TaskId, UsageLedger, UsageQuery, UsageRecord } from '@melon-ai/core';
import type { SqliteContext } from './db.js';
import { rollupRecords } from '../usage.js';

type Row = {
  at: number; calls: number; task_id: string | null; agent_id: string | null; task_kind: string | null; trig: string | null;
  purpose: string; egress: string; model: string; ok: number; error_code: string | null; attempt: number | null;
  in_tokens: number; cached_tokens: number; out_tokens: number; cost: number; currency: string; priced: number; ms: number;
  billing: string | null;
};

const toRecord = (r: Row): UsageRecord => ({
  at: r.at, calls: r.calls, purpose: r.purpose, egress: r.egress, model: r.model, ok: r.ok === 1,
  ...(r.task_id !== null ? { taskId: r.task_id as TaskId } : {}),
  ...(r.agent_id !== null ? { agentId: r.agent_id } : {}),
  ...(r.task_kind !== null ? { taskKind: r.task_kind } : {}),
  ...(r.trig !== null ? { trigger: r.trig } : {}),
  ...(r.error_code !== null ? { errorCode: r.error_code } : {}),
  ...(r.attempt !== null ? { attempt: r.attempt } : {}),
  inputTokens: r.in_tokens, cachedInputTokens: r.cached_tokens, outputTokens: r.out_tokens,
  cost: r.cost, currency: r.currency as Currency, priced: r.priced === 1, ms: r.ms,
  ...(r.billing === 'plan' ? { billing: 'plan' as const } : {}),
});

const INSERT = `INSERT INTO usage (at, rolled, calls, task_id, agent_id, task_kind, trig, purpose, egress, model, ok, error_code,
  attempt, in_tokens, cached_tokens, out_tokens, cost, currency, priced, ms, billing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export class SqliteUsageLedger implements UsageLedger {
  constructor(private readonly cx: SqliteContext) {}

  private insert(r: UsageRecord, rolled: boolean): void {
    this.cx.db.prepare(INSERT).run(
      r.at, rolled ? 1 : 0, r.calls, r.taskId ?? null, r.agentId ?? null, r.taskKind ?? null, r.trigger ?? null,
      r.purpose, r.egress, r.model, r.ok ? 1 : 0, r.errorCode ?? null, r.attempt ?? null,
      r.inputTokens, r.cachedInputTokens, r.outputTokens, r.cost, r.currency, r.priced ? 1 : 0, Math.round(r.ms),
      r.billing ?? null,
    );
  }

  async record(r: UsageRecord): Promise<void> {
    this.insert(r, false);
  }

  async list(q: UsageQuery): Promise<readonly UsageRecord[]> {
    const rows = this.cx.db.prepare('SELECT * FROM usage WHERE at >= ? AND at < ? ORDER BY at, id').all(q.from, q.to) as Row[];
    return rows.map(toRecord);
  }

  /** 汇总与删除在一个事务里：中途崩掉不会既删了明细又没写汇总。 */
  async rollup(before: number): Promise<number> {
    const rows = this.cx.db.prepare('SELECT * FROM usage WHERE rolled = 0 AND at < ?').all(before) as Row[];
    if (rows.length === 0) return 0;
    const sums = rollupRecords(rows.map(toRecord));
    await this.cx.transaction(async () => {
      this.cx.db.prepare('DELETE FROM usage WHERE rolled = 0 AND at < ?').run(before);
      for (const r of sums) this.insert(r, true);
    });
    return rows.length;
  }
}

export class SqlitePriceStore implements PriceStore {
  constructor(private readonly cx: SqliteContext) {}

  async put(sync: PriceSync): Promise<void> {
    this.cx.db.prepare('INSERT INTO price_sync (vendor, at, payload) VALUES (?,?,?) ON CONFLICT(vendor) DO UPDATE SET at=excluded.at, payload=excluded.payload')
      .run(sync.vendor, sync.at, JSON.stringify(sync));
  }

  async get(vendor: string): Promise<PriceSync | null> {
    const r = this.cx.db.prepare('SELECT payload FROM price_sync WHERE vendor = ?').get(vendor) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) as PriceSync : null;
  }

  async list(): Promise<readonly PriceSync[]> {
    return (this.cx.db.prepare('SELECT payload FROM price_sync ORDER BY vendor').all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as PriceSync);
  }
}
