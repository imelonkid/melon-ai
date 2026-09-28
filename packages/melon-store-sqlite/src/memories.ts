import type {
  AgentId, Memory, MemoryId, MemoryQuery, MemoryStore, Scored, TaskId, VectorIndex,
} from '@melon-ai/core';
import type { SqliteContext } from './db.js';

type Row = {
  rowid: number; id: string; scope: string; agent_id: string | null; kind: string;
  subject: string; statement: string; confidence: number; importance: number;
  created_at: number; last_used_at: number; use_count: number;
  supersedes: string | null; ttl: number | null; task_id: string; event_seq: number;
  superseded_by: string | null;
};

const toMemory = (r: Row): Memory => ({
  id: r.id as MemoryId,
  scope: r.scope as Memory['scope'],
  ...(r.agent_id !== null ? { agentId: r.agent_id as AgentId } : {}),
  kind: r.kind as Memory['kind'],
  subject: r.subject,
  statement: r.statement,
  confidence: r.confidence,
  importance: r.importance,
  provenance: { taskId: r.task_id as TaskId, eventSeq: r.event_seq },
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
  ...(r.supersedes !== null ? { supersedes: r.supersedes as MemoryId } : {}),
  ...(r.ttl !== null ? { ttl: r.ttl } : {}),
});

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly cx: SqliteContext) {}

  async put(m: Memory): Promise<void> {
    const info = this.cx.db.prepare(`
      INSERT INTO memories (id, scope, agent_id, kind, subject, statement, confidence, importance,
                            created_at, last_used_at, use_count, supersedes, ttl, task_id, event_seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET statement=excluded.statement, confidence=excluded.confidence,
        importance=excluded.importance, last_used_at=excluded.last_used_at, use_count=excluded.use_count
    `).run(
      m.id, m.scope, m.agentId ?? null, m.kind, m.subject, m.statement, m.confidence, m.importance,
      m.createdAt, m.lastUsedAt, m.useCount, m.supersedes ?? null, m.ttl ?? null,
      m.provenance.taskId, m.provenance.eventSeq,
    );
    const rowid = info.lastInsertRowid;
    this.cx.db.prepare('INSERT OR REPLACE INTO memories_fts (rowid, statement, subject) VALUES (?,?,?)')
      .run(rowid, m.statement, m.subject);
  }

  async get(id: MemoryId): Promise<Memory | null> {
    const r = this.cx.db.prepare('SELECT rowid, * FROM memories WHERE id=?').get(id) as Row | undefined;
    return r ? toMemory(r) : null;
  }

  async findBySubject(scope: Memory['scope'], subject: string, kind: Memory['kind']): Promise<readonly Memory[]> {
    const rows = this.cx.db.prepare(
      'SELECT rowid, * FROM memories WHERE scope=? AND subject=? AND kind=? AND superseded_by IS NULL',
    ).all(scope, subject, kind) as Row[];
    return rows.map(toMemory);
  }

  /** 关键词检索走 FTS5。向量检索走 VectorIndex，两路结果由 @melon-ai/memory 融合。 */
  async search(q: MemoryQuery): Promise<readonly Scored<Memory>[]> {
    const active = q.activeOnly !== false ? 'AND m.superseded_by IS NULL' : '';
    const kinds = q.kinds && q.kinds.length > 0
      ? `AND m.kind IN (${q.kinds.map(() => '?').join(',')})` : '';
    const agent = q.agentId !== undefined ? 'AND m.agent_id=?' : '';
    const params: unknown[] = [];

    let rows: (Row & { score: number })[];
    if (q.text !== undefined && q.text.trim() !== '') {
      params.push(escapeFts(q.text), q.scope);
      if (q.agentId !== undefined) params.push(q.agentId);
      if (q.kinds) params.push(...q.kinds);
      rows = this.cx.db.prepare(`
        SELECT m.rowid, m.*, -bm25(memories_fts) AS score
        FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ? AND m.scope=? ${agent} ${kinds} ${active}
        ORDER BY score DESC LIMIT ?
      `).all(...params, q.limit) as (Row & { score: number })[];
    } else {
      params.push(q.scope);
      if (q.agentId !== undefined) params.push(q.agentId);
      if (q.kinds) params.push(...q.kinds);
      rows = this.cx.db.prepare(`
        SELECT m.rowid, m.*, m.importance AS score FROM memories m
        WHERE m.scope=? ${agent} ${kinds} ${active}
        ORDER BY m.importance DESC, m.last_used_at DESC LIMIT ?
      `).all(...params, q.limit) as (Row & { score: number })[];
    }
    return rows.map((r) => ({ item: toMemory(r), score: r.score }));
  }

  /** 标记替代关系，**不物理删除** —— §2.5 的 supersede 动因。 */
  async supersede(oldId: MemoryId, newId: MemoryId): Promise<void> {
    this.cx.db.prepare('UPDATE memories SET superseded_by=? WHERE id=?').run(newId, oldId);
  }

  async touch(ids: readonly MemoryId[], at: number): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.cx.db.prepare(
      'UPDATE memories SET last_used_at=?, use_count=use_count+1 WHERE id=?',
    );
    for (const id of ids) stmt.run(at, id);
  }

  /**
   * 按来源任务物理删除 —— §2.5 的 privacy 动因。
   * 必须一并清 FTS 与向量条目，否则删了还能被召回。
   */
  async forgetByTask(taskId: TaskId): Promise<number> {
    const rows = this.cx.db.prepare('SELECT rowid, id FROM memories WHERE task_id=?')
      .all(taskId) as { rowid: number; id: string }[];
    for (const r of rows) {
      this.cx.db.prepare('DELETE FROM memories_fts WHERE rowid=?').run(r.rowid);
      this.cx.db.prepare('DELETE FROM vectors WHERE id=?').run(r.id);
    }
    return this.cx.db.prepare('DELETE FROM memories WHERE task_id=?').run(taskId).changes;
  }
}

/** FTS5 的 MATCH 语法对特殊字符敏感，整句加引号最稳。 */
const escapeFts = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * 向量索引：**暴力余弦**，不用 sqlite-vec。
 *
 * 取舍（已同步 architecture.md §6.1）：sqlite-vec 是原生扩展，
 * 在 Electron 里要为每个平台打包二进制并处理扩展加载 —— 成本不低。
 * 而桌面端单用户量级（O(10k) 条记忆 × 384 维）暴力算一遍约十几毫秒，完全够用。
 * 到 10 万条以上再换 sqlite-vec，届时只换这个类。
 */
export class SqliteVectorIndex implements VectorIndex {
  constructor(private readonly cx: SqliteContext, readonly dims: number) {}

  async upsert(id: string, vector: Float32Array, meta?: Record<string, unknown>): Promise<void> {
    if (vector.length !== this.dims) {
      throw new Error(`向量维度不符：期望 ${this.dims}，收到 ${vector.length}`);
    }
    this.cx.db.prepare('INSERT OR REPLACE INTO vectors (id, dims, vec, meta) VALUES (?,?,?,?)')
      .run(id, this.dims, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        meta ? JSON.stringify(meta) : null);
  }

  async query(vector: Float32Array, k: number): Promise<readonly Scored<string>[]> {
    const rows = this.cx.db.prepare('SELECT id, vec FROM vectors WHERE dims=?')
      .all(this.dims) as { id: string; vec: Buffer }[];
    const scored = rows.map((r) => {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
      return { item: r.id, score: cosine(vector, v) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async remove(id: string): Promise<void> {
    this.cx.db.prepare('DELETE FROM vectors WHERE id=?').run(id);
  }

  get size(): number {
    return (this.cx.db.prepare('SELECT COUNT(*) c FROM vectors').get() as { c: number }).c;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
