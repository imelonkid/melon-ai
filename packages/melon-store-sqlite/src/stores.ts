import type {
  AgentId, Entry, Episode, EpisodeId, EpisodeStore, EpisodeSummary, EventLog, Grant, GrantStore,
  IdempotencyStore, Sequenced, Task, TaskEvent, TaskId, TaskState, TaskStore, ToolResult,
} from '@melon-ai/core';
import { ConflictError, asEpisodeId } from '@melon-ai/core';
import type { SqliteContext } from './db.js';
import { json, unjson } from './db.js';

/** tasks 表里被单独拉成列的字段，其余走 body JSON。 */
type TaskRow = {
  id: string; parent_id: string | null; root_id: string; agent_id: string;
  kind: string; goal: string; state: string; deadline: number | null;
  created_at: number; updated_at: number; version: number; body: string;
};

const toTask = (r: TaskRow): Task => ({
  ...(unjson<Omit<Task, 'id' | 'rootId' | 'agentId' | 'kind' | 'goal' | 'state' | 'createdAt' | 'updatedAt' | 'version'>>(r.body)),
  id: r.id as TaskId,
  ...(r.parent_id !== null ? { parentId: r.parent_id as TaskId } : {}),
  rootId: r.root_id as TaskId,
  agentId: r.agent_id as AgentId,
  kind: r.kind as Task['kind'],
  goal: r.goal,
  state: r.state as TaskState,
  ...(r.deadline !== null ? { deadline: r.deadline } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const bodyOf = (t: Task): string => {
  const { id: _i, parentId: _p, rootId: _r, agentId: _a, kind: _k, goal: _g, state: _s,
    deadline: _d, createdAt: _c, updatedAt: _u, version: _v, ...rest } = t;
  return json(rest);
};

export class SqliteTaskStore implements TaskStore {
  constructor(private readonly cx: SqliteContext) {}

  async create(task: Task): Promise<void> {
    this.cx.db.prepare(`
      INSERT INTO tasks (id, parent_id, root_id, agent_id, kind, goal, state, deadline,
                         created_at, updated_at, version, body)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      task.id, task.parentId ?? null, task.rootId, task.agentId, task.kind, task.goal,
      task.state, task.deadline ?? null, task.createdAt, task.updatedAt, task.version, bodyOf(task),
    );
  }

  async get(id: TaskId): Promise<Task | null> {
    const r = this.cx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return r ? toTask(r) : null;
  }

  /** 乐观并发：靠 `WHERE version = ?` 的影响行数判断，语义与内存版一致。 */
  async save(task: Task, expectedVersion: number): Promise<void> {
    const info = this.cx.db.prepare(`
      UPDATE tasks SET parent_id=?, root_id=?, agent_id=?, kind=?, goal=?, state=?, deadline=?,
                       updated_at=?, version=?, body=?
      WHERE id = ? AND version = ?
    `).run(
      task.parentId ?? null, task.rootId, task.agentId, task.kind, task.goal, task.state,
      task.deadline ?? null, task.updatedAt, task.version, bodyOf(task), task.id, expectedVersion,
    );
    if (info.changes === 0) {
      const cur = await this.get(task.id);
      if (!cur) throw new Error(`task missing: ${task.id}`);
      throw new ConflictError(expectedVersion, cur.version);
    }
  }

  async listByState(states: readonly TaskState[], limit: number): Promise<readonly Task[]> {
    if (states.length === 0) return [];
    const q = states.map(() => '?').join(',');
    const rows = this.cx.db.prepare(
      `SELECT * FROM tasks WHERE state IN (${q}) ORDER BY created_at LIMIT ?`,
    ).all(...states, limit) as TaskRow[];
    return rows.map(toTask);
  }

  async listChildren(parentId: TaskId): Promise<readonly Task[]> {
    const rows = this.cx.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at')
      .all(parentId) as TaskRow[];
    return rows.map(toTask);
  }

  async listDue(now: number, limit: number): Promise<readonly Task[]> {
    const rows = this.cx.db.prepare(
      `SELECT * FROM tasks WHERE state = 'SUSPENDED' AND deadline IS NOT NULL AND deadline <= ?
       ORDER BY deadline LIMIT ?`,
    ).all(now, limit) as TaskRow[];
    return rows.map(toTask);
  }
}

export class SqliteEventLog implements EventLog {
  private readonly subs = new Map<string, Set<(e: Sequenced<TaskEvent>) => void>>();
  constructor(private readonly cx: SqliteContext, private readonly now: () => number = () => Date.now()) {}

  async append(taskId: TaskId, events: readonly TaskEvent[], expectedSeq: number): Promise<number> {
    const last = await this.lastSeq(taskId);
    // 单写者语义，与内存版一致：不符必须失败，否则事件顺序不可信、重放不可信
    if (last !== expectedSeq) throw new ConflictError(expectedSeq, last);
    const at = this.now();
    const stmt = this.cx.db.prepare(
      'INSERT INTO task_events (task_id, seq, at, type, payload) VALUES (?,?,?,?,?)',
    );
    let seq = last;
    const added: Sequenced<TaskEvent>[] = [];
    for (const e of events) {
      seq += 1;
      stmt.run(taskId, seq, at, e.t, json(e));
      added.push({ seq, at, value: e });
    }
    for (const e of added) {
      for (const cb of this.subs.get(taskId) ?? []) cb(e);
    }
    return seq;
  }

  async *read(taskId: TaskId, fromSeq = 0): AsyncIterable<Sequenced<TaskEvent>> {
    const rows = this.cx.db.prepare(
      'SELECT seq, at, payload FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq',
    ).all(taskId, fromSeq) as { seq: number; at: number; payload: string }[];
    for (const r of rows) yield { seq: r.seq, at: r.at, value: unjson<TaskEvent>(r.payload) };
  }

  async lastSeq(taskId: TaskId): Promise<number> {
    const r = this.cx.db.prepare('SELECT MAX(seq) m FROM task_events WHERE task_id = ?')
      .get(taskId) as { m: number | null };
    return r.m ?? 0;
  }

  subscribe(taskId: TaskId, cb: (e: Sequenced<TaskEvent>) => void): () => void {
    const set = this.subs.get(taskId) ?? new Set();
    set.add(cb);
    this.subs.set(taskId, set);
    return () => { set.delete(cb); };
  }
}

export class SqliteEpisodeStore implements EpisodeStore {
  private n = 0;
  constructor(private readonly cx: SqliteContext) {
    const r = this.cx.db.prepare('SELECT COUNT(*) c FROM episodes').get() as { c: number };
    this.n = r.c;
  }

  async open(rootId: TaskId, at: number): Promise<EpisodeId> {
    const id = asEpisodeId(`ep-${rootId}-${++this.n}`);
    this.cx.db.prepare('INSERT INTO episodes (id, root_id, state, opened_at) VALUES (?,?,?,?)')
      .run(id, rootId, 'open', at);
    return id;
  }

  async append(id: EpisodeId, entry: Entry): Promise<void> {
    const r = this.cx.db.prepare('SELECT MAX(seq) m FROM entries WHERE episode_id = ?')
      .get(id) as { m: number | null };
    this.cx.db.prepare('INSERT INTO entries (episode_id, seq, payload) VALUES (?,?,?)')
      .run(id, (r.m ?? 0) + 1, json(entry));
  }

  async close(id: EpisodeId, at: number): Promise<void> {
    this.cx.db.prepare("UPDATE episodes SET state='closed', closed_at=? WHERE id=?").run(at, id);
  }

  async setSummary(id: EpisodeId, summary: EpisodeSummary): Promise<void> {
    this.cx.db.prepare("UPDATE episodes SET summary=?, state='compacted' WHERE id=?")
      .run(json(summary), id);
  }

  async get(id: EpisodeId): Promise<Episode | null> {
    const r = this.cx.db.prepare('SELECT * FROM episodes WHERE id=?').get(id) as
      { id: string; root_id: string; state: string; opened_at: number; closed_at: number | null; summary: string | null } | undefined;
    if (!r) return null;
    return {
      id: r.id as EpisodeId, rootId: r.root_id as TaskId, state: r.state as Episode['state'],
      openedAt: r.opened_at,
      ...(r.closed_at !== null ? { closedAt: r.closed_at } : {}),
      ...(r.summary !== null ? { summary: unjson<EpisodeSummary>(r.summary) } : {}),
    };
  }

  async list(rootId: TaskId): Promise<readonly Episode[]> {
    const rows = this.cx.db.prepare('SELECT id FROM episodes WHERE root_id=? ORDER BY opened_at')
      .all(rootId) as { id: string }[];
    const out: Episode[] = [];
    for (const r of rows) {
      const e = await this.get(r.id as EpisodeId);
      if (e) out.push(e);
    }
    return out;
  }

  /** 压缩有损，但原文永远留着 —— 这个方法就是取回原文的路。 */
  async readEntries(id: EpisodeId, range?: { from: number; to: number }): Promise<readonly Entry[]> {
    const rows = range
      ? this.cx.db.prepare('SELECT payload FROM entries WHERE episode_id=? AND seq BETWEEN ? AND ? ORDER BY seq')
          .all(id, range.from, range.to) as { payload: string }[]
      : this.cx.db.prepare('SELECT payload FROM entries WHERE episode_id=? ORDER BY seq')
          .all(id) as { payload: string }[];
    return rows.map((r) => unjson<Entry>(r.payload));
  }
}

export class SqliteGrantStore implements GrantStore {
  constructor(private readonly cx: SqliteContext) {}

  async find(agentId: AgentId, toolId: string, scope: string): Promise<Grant | null> {
    const r = this.cx.db.prepare(
      'SELECT * FROM grants WHERE agent_id=? AND tool_id=? AND scope=?',
    ).get(agentId, toolId, scope) as
      { agent_id: string; tool_id: string; scope: string; granted_at: number; expires_at: number | null } | undefined;
    if (!r) return null;
    return {
      agentId: r.agent_id as AgentId, toolId: r.tool_id as Grant['toolId'], scope: r.scope,
      grantedAt: r.granted_at,
      ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    };
  }

  async put(grant: Grant): Promise<void> {
    this.cx.db.prepare(`
      INSERT INTO grants (agent_id, tool_id, scope, granted_at, expires_at) VALUES (?,?,?,?,?)
      ON CONFLICT(agent_id, tool_id, scope) DO UPDATE SET granted_at=excluded.granted_at, expires_at=excluded.expires_at
    `).run(grant.agentId, grant.toolId, grant.scope, grant.grantedAt, grant.expiresAt ?? null);
  }

  async revoke(agentId: AgentId, toolId: string, scope?: string): Promise<void> {
    if (scope === undefined) {
      this.cx.db.prepare('DELETE FROM grants WHERE agent_id=? AND tool_id=?').run(agentId, toolId);
    } else {
      this.cx.db.prepare('DELETE FROM grants WHERE agent_id=? AND tool_id=? AND scope=?')
        .run(agentId, toolId, scope);
    }
  }

  /** 供设置页展示「我都始终允许过什么」—— scope 可读是这个功能的前提。 */
  async listByAgent(agentId: AgentId): Promise<readonly Grant[]> {
    const rows = this.cx.db.prepare('SELECT scope, tool_id, granted_at, expires_at FROM grants WHERE agent_id=?')
      .all(agentId) as { scope: string; tool_id: string; granted_at: number; expires_at: number | null }[];
    return rows.map((r) => ({
      agentId, toolId: r.tool_id as Grant['toolId'], scope: r.scope, grantedAt: r.granted_at,
      ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    }));
  }
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(private readonly cx: SqliteContext, private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<ToolResult | null> {
    const r = this.cx.db.prepare('SELECT result, expires_at FROM idempotency WHERE key=?')
      .get(key) as { result: string; expires_at: number } | undefined;
    if (!r) return null;
    if (r.expires_at <= this.now()) {
      this.cx.db.prepare('DELETE FROM idempotency WHERE key=?').run(key);
      return null;
    }
    return unjson<ToolResult>(r.result);
  }

  async put(key: string, result: ToolResult, ttlMs: number): Promise<void> {
    this.cx.db.prepare(
      'INSERT OR REPLACE INTO idempotency (key, result, expires_at) VALUES (?,?,?)',
    ).run(key, json(result), this.now() + ttlMs);
  }
}
