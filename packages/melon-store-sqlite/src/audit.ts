import type {
  AuditAction, AuditQuery, AuditRecord, AuditSink, SpanId, TaskId, TraceId,
} from '@melon-ai/core';
import type { SqliteContext } from './db.js';
import { json, unjson } from './db.js';

type Row = {
  seq: number; at: number; actor_kind: string; actor_id: string; action: string;
  res_kind: string; res_ref: string; res_hash: string | null; outcome: string;
  trace_id: string; span_id: string | null; task_id: string | null;
  dimensions: string | null; basis: string | null; prev_hash: string | null; hash: string;
};

const toRecord = (r: Row): AuditRecord => ({
  seq: r.seq, at: r.at,
  actor: { kind: r.actor_kind as AuditRecord['actor']['kind'], id: r.actor_id },
  action: r.action as AuditAction,
  resource: {
    kind: r.res_kind, ref: r.res_ref,
    ...(r.res_hash !== null ? { contentHash: r.res_hash } : {}),
  },
  outcome: r.outcome as AuditRecord['outcome'],
  traceId: r.trace_id as TraceId,
  ...(r.span_id !== null ? { spanId: r.span_id as SpanId } : {}),
  ...(r.task_id !== null ? { taskId: r.task_id as TaskId } : {}),
  ...(r.dimensions !== null ? { dimensions: unjson<NonNullable<AuditRecord['dimensions']>>(r.dimensions) } : {}),
  ...(r.basis !== null ? { basis: unjson<NonNullable<AuditRecord['basis']>>(r.basis) } : {}),
  ...(r.prev_hash !== null ? { prevHash: r.prev_hash } : {}),
  hash: r.hash,
});

export class SqliteAuditSink implements AuditSink {
  constructor(private readonly cx: SqliteContext) {}

  async append(r: AuditRecord): Promise<void> {
    this.cx.db.prepare(`
      INSERT INTO audit (seq, at, actor_kind, actor_id, action, res_kind, res_ref, res_hash,
                         outcome, trace_id, span_id, task_id, dimensions, basis, prev_hash, hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      r.seq, r.at, r.actor.kind, r.actor.id, r.action, r.resource.kind, r.resource.ref,
      r.resource.contentHash ?? null, r.outcome, r.traceId, r.spanId ?? null, r.taskId ?? null,
      r.dimensions ? json(r.dimensions) : null, r.basis ? json(r.basis) : null,
      r.prevHash ?? null, r.hash,
    );
  }

  /** 按 seq 倒序（最新在前）—— 审计的常见读法是「最近发生了什么」，与内存版一致。 */
  async query(q: AuditQuery): Promise<readonly AuditRecord[]> {
    const w: string[] = [];
    const p: unknown[] = [];
    if (q.actor) { w.push('actor_kind=? AND actor_id=?'); p.push(q.actor.kind, q.actor.id); }
    if (q.actions && q.actions.length > 0) {
      w.push(`action IN (${q.actions.map(() => '?').join(',')})`); p.push(...q.actions);
    }
    if (q.resourceKind) { w.push('res_kind=?'); p.push(q.resourceKind); }
    if (q.resourceRef) { w.push('res_ref=?'); p.push(q.resourceRef); }
    if (q.taskId) { w.push('task_id=?'); p.push(q.taskId); }
    if (q.traceId) { w.push('trace_id=?'); p.push(q.traceId); }
    if (q.from !== undefined) { w.push('at>=?'); p.push(q.from); }
    if (q.to !== undefined) { w.push('at<=?'); p.push(q.to); }
    const sql = `SELECT * FROM audit ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    const rows = this.cx.db.prepare(sql).all(...p, Math.min(q.limit, 1_000_000)) as Row[];
    return rows.map(toRecord);
  }

  async lastHash(): Promise<string | undefined> {
    const r = this.cx.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')
      .get() as { hash: string } | undefined;
    return r?.hash;
  }

  /** keepForever 的动作不随保留期清理 —— 审计保留期可以长于任务本身。 */
  async prune(before: number, keep: readonly AuditAction[]): Promise<number> {
    const q = keep.length > 0 ? `AND action NOT IN (${keep.map(() => '?').join(',')})` : '';
    const info = this.cx.db.prepare(`DELETE FROM audit WHERE at < ? ${q}`).run(before, ...keep);
    return info.changes;
  }

  async verify(fromSeq = 0): Promise<number | null> {
    const rows = this.cx.db.prepare('SELECT seq FROM audit WHERE seq > ? ORDER BY seq')
      .all(fromSeq) as { seq: number }[];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.seq !== rows[i - 1]!.seq + 1) return rows[i]!.seq;
    }
    return null;
  }
}
