import type {
  EventLog, Sequenced, Task, TaskEvent, TaskId, TaskState, TaskStore,
} from '@melon-ai/core';
import { ConflictError } from '@melon-ai/core';

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
  /** 由调用方注入时间，保持确定性。 */
  constructor(private readonly now: () => number = () => 0) {}

  async append(taskId: TaskId, events: readonly TaskEvent[], expectedSeq: number): Promise<number> {
    const rows = this.logs.get(taskId) ?? [];
    const last = rows.length === 0 ? 0 : rows[rows.length - 1]!.seq;
    // 单写者语义。并发追加必须有一方失败，否则事件顺序不可信、重放就不可信
    if (last !== expectedSeq) throw new ConflictError(expectedSeq, last);
    let seq = last;
    const added: Sequenced<TaskEvent>[] = [];
    for (const value of events) {
      added.push({ seq: ++seq, at: this.now(), value });
    }
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
