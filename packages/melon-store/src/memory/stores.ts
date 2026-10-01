import type {
  AgentId, Entry, Episode, EpisodeId, EpisodeStore, EpisodeSummary, EventLog, Grant, GrantStore,
  IdempotencyStore, Schedule, ScheduleId, ScheduleStatus, ScheduleStore, Sequenced, Task, TaskEvent,
  TaskId, TaskState, TaskStore, ToolResult, UsageLedger, UsageQuery, UsageRecord,
} from '@melon-ai/core';
import { ConflictError, asEpisodeId } from '@melon-ai/core';
import { rollupRecords } from '../usage.js';

/**
 * 内存存储：任务、事件、片段、定时、授权、幂等。
 *
 * 语义与 SQLite 版一致（乐观并发、单写者、不物理删的版本链……），
 * 由 test/memory 与 test/sqlite 的同一组一致性断言守着 ——
 * 否则「用内存跑通、上 SQLite 就炸」这类问题极难定位。
 */

export class InMemoryTaskStore implements TaskStore {
  private readonly rows = new Map<string, Task>();

  async create(task: Task): Promise<void> {
    if (this.rows.has(task.id)) throw new Error(`task exists: ${task.id}`);
    this.rows.set(task.id, task);
  }
  async get(id: TaskId): Promise<Task | null> {
    return this.rows.get(id) ?? null;
  }
  async save(task: Task, expectedVersion: number): Promise<void> {
    const cur = this.rows.get(task.id);
    if (!cur) throw new Error(`task missing: ${task.id}`);
    // 乐观并发：语义要和 SQLite 实现一致，否则测试过了线上还会炸
    if (cur.version !== expectedVersion) throw new ConflictError(expectedVersion, cur.version);
    this.rows.set(task.id, task);
  }
  async listByState(states: readonly TaskState[], limit: number): Promise<readonly Task[]> {
    return [...this.rows.values()]
      .filter((t) => states.includes(t.state))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }
  async listChildren(parentId: TaskId): Promise<readonly Task[]> {
    return [...this.rows.values()].filter((t) => t.parentId === parentId);
  }
  async listDue(now: number, limit: number): Promise<readonly Task[]> {
    return [...this.rows.values()]
      .filter((t) => t.state === 'SUSPENDED' && t.deadline !== undefined && t.deadline <= now)
      .slice(0, limit);
  }
  get size(): number { return this.rows.size; }
}

export class InMemoryEventLog implements EventLog {
  private readonly logs = new Map<string, Sequenced<TaskEvent>[]>();
  private readonly subs = new Map<string, Set<(e: Sequenced<TaskEvent>) => void>>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async append(taskId: TaskId, events: readonly TaskEvent[], expectedSeq: number): Promise<number> {
    const rows = this.logs.get(taskId) ?? [];
    const last = rows.length === 0 ? 0 : rows[rows.length - 1]!.seq;
    // 单写者语义。并发追加必须有一方失败，否则事件顺序不可信、重放就不可信
    if (last !== expectedSeq) throw new ConflictError(expectedSeq, last);
    let seq = last;
    const added: Sequenced<TaskEvent>[] = [];
    for (const value of events) added.push({ seq: ++seq, at: this.now(), value });
    this.logs.set(taskId, [...rows, ...added]);
    for (const e of added) {
      for (const cb of this.subs.get(taskId) ?? []) cb(e);
    }
    return seq;
  }

  async *read(taskId: TaskId, fromSeq = 0): AsyncIterable<Sequenced<TaskEvent>> {
    for (const row of this.logs.get(taskId) ?? []) {
      if (row.seq > fromSeq) yield row;
    }
  }

  async lastSeq(taskId: TaskId): Promise<number> {
    const rows = this.logs.get(taskId) ?? [];
    return rows.length === 0 ? 0 : rows[rows.length - 1]!.seq;
  }

  subscribe(taskId: TaskId, cb: (e: Sequenced<TaskEvent>) => void): () => void {
    const set = this.subs.get(taskId) ?? new Set();
    set.add(cb);
    this.subs.set(taskId, set);
    return () => { set.delete(cb); };
  }

  /** 断言用：同步取全量，不必 for-await。 */
  all(taskId: TaskId): readonly Sequenced<TaskEvent>[] { return this.logs.get(taskId) ?? []; }
  types(taskId: TaskId): readonly string[] { return this.all(taskId).map((r) => r.value.t); }
}

export class InMemoryEpisodeStore implements EpisodeStore {
  private readonly rows = new Map<string, Episode>();
  private readonly entries = new Map<string, Entry[]>();
  private n = 0;

  async open(rootId: TaskId, at: number): Promise<EpisodeId> {
    const id = asEpisodeId(`ep-${rootId}-${++this.n}`);
    this.rows.set(id, { id, rootId, state: 'open', openedAt: at });
    this.entries.set(id, []);
    return id;
  }
  async append(id: EpisodeId, entry: Entry): Promise<void> {
    const list = this.entries.get(id);
    if (!list) throw new Error(`episode missing: ${id}`);
    list.push(entry);
  }
  async close(id: EpisodeId, at: number): Promise<void> {
    const e = this.rows.get(id);
    if (e) this.rows.set(id, { ...e, state: 'closed', closedAt: at });
  }
  async setSummary(id: EpisodeId, summary: EpisodeSummary): Promise<void> {
    const e = this.rows.get(id);
    if (e) this.rows.set(id, { ...e, state: 'compacted', summary });
  }
  async get(id: EpisodeId): Promise<Episode | null> {
    return this.rows.get(id) ?? null;
  }
  async list(rootId: TaskId): Promise<readonly Episode[]> {
    return [...this.rows.values()].filter((e) => e.rootId === rootId).sort((a, b) => a.openedAt - b.openedAt);
  }
  /** range 是 1 起的闭区间，与 SQLite 版的 seq BETWEEN 一致。 */
  async readEntries(id: EpisodeId, range?: { from: number; to: number }): Promise<readonly Entry[]> {
    const list = this.entries.get(id) ?? [];
    return range ? list.slice(range.from - 1, range.to) : [...list];
  }
  /** 给清理用：物理删除一个片段及其原文。 */
  purge(id: string): boolean {
    this.entries.delete(id);
    return this.rows.delete(id);
  }
}

export class InMemoryGrantStore implements GrantStore {
  readonly rows: Grant[] = [];
  private key(agentId: string, toolId: string, scope: string): string {
    return `${agentId}|${toolId}|${scope}`;
  }
  async find(agentId: AgentId, toolId: string, scope: string): Promise<Grant | null> {
    return this.rows.find((g) => this.key(g.agentId, g.toolId, g.scope) === this.key(agentId, toolId, scope)) ?? null;
  }
  async put(grant: Grant): Promise<void> {
    await this.revoke(grant.agentId, grant.toolId, grant.scope);
    this.rows.push(grant);
  }
  async revoke(agentId: AgentId, toolId: string, scope?: string): Promise<void> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const g = this.rows[i]!;
      if (g.agentId === agentId && g.toolId === toolId && (scope === undefined || g.scope === scope)) {
        this.rows.splice(i, 1);
      }
    }
  }
  async listByAgent(agentId: AgentId): Promise<readonly Grant[]> {
    return this.rows.filter((g) => g.agentId === agentId);
  }
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly rows = new Map<string, Schedule>();

  async put(s: Schedule): Promise<void> { this.rows.set(s.id, s); }
  async get(id: ScheduleId): Promise<Schedule | null> { return this.rows.get(id) ?? null; }
  async listDue(now: number, limit: number): Promise<readonly Schedule[]> {
    return [...this.rows.values()]
      .filter((s) => s.status === 'active' && s.nextFireAt !== null && s.nextFireAt <= now)
      .sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0))
      .slice(0, limit);
  }
  /** 不传 status 则返回除 removed 外的全部，最新的在前（与 SQLite 版一致）。 */
  async list(agentId?: AgentId, status?: ScheduleStatus): Promise<readonly Schedule[]> {
    return [...this.rows.values()]
      .filter((s) => (status ? s.status === status : s.status !== 'removed'))
      .filter((s) => (agentId ? s.template.agentId === agentId : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async supersede(oldId: ScheduleId, newId: ScheduleId): Promise<void> {
    const prev = this.rows.get(oldId);
    if (prev) this.rows.set(oldId, { ...prev, supersededBy: newId, status: 'removed', nextFireAt: null });
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, { result: ToolResult; expiresAt: number }>();
  readonly hits: string[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<ToolResult | null> {
    const hit = this.rows.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) { this.rows.delete(key); return null; }
    this.hits.push(key);
    return hit.result;
  }
  async put(key: string, result: ToolResult, ttlMs = 3_600_000): Promise<void> {
    this.rows.set(key, { result, expiresAt: this.now() + ttlMs });
  }
}

/** 用量账本（内存）。明细与汇总行分开放，汇总只动明细。 */
export class InMemoryUsageLedger implements UsageLedger {
  private details: UsageRecord[] = [];
  private rolled: UsageRecord[] = [];

  async record(r: UsageRecord): Promise<void> {
    this.details.push(r);
  }

  async list(q: UsageQuery): Promise<readonly UsageRecord[]> {
    return [...this.rolled, ...this.details].filter((r) => r.at >= q.from && r.at < q.to).sort((a, b) => a.at - b.at);
  }

  async rollup(before: number): Promise<number> {
    const old = this.details.filter((r) => r.at < before);
    if (old.length === 0) return 0;
    this.details = this.details.filter((r) => r.at >= before);
    this.rolled.push(...rollupRecords(old));
    return old.length;
  }
}
