import type {
  AgentId, ArtifactRef, EpisodeId, MemoryId, Scored, Sequenced, TaskId,
} from '../ids.js';
import type { Task, TaskEvent, TaskState } from '../task.js';
import type { Entry, Episode, EpisodeSummary, Memory, MemoryQuery } from '../memory.js';
import type { Grant } from '../policy.js';
import type { Schedule, ScheduleId, ScheduleStatus } from '../schedule.js';
import type { Archive, Purger } from '../deletion.js';

/**
 * ─── 依赖倒置的核心 ───
 * 以下全部是**端口**。领域模块只依赖这些接口，永远不依赖任何具体存储。
 * 基础设施模块（melon-store-sqlite 等）实现它们，且只依赖 melon-core。
 * 所以适配器之间互不认识，换存储不动领域代码。
 */

export interface TaskStore {
  create(task: Task): Promise<void>;
  get(id: TaskId): Promise<Task | null>;
  /** 乐观并发：expectedVersion 与库中不符时抛 ConflictError。 */
  save(task: Task, expectedVersion: number): Promise<void>;
  listByState(states: readonly TaskState[], limit: number): Promise<readonly Task[]>;
  listChildren(parentId: TaskId): Promise<readonly Task[]>;
  /** 到期该唤醒的挂起任务。调度器轮询用。 */
  listDue(now: number, limit: number): Promise<readonly Task[]>;
}

export interface EventLog {
  /** expectedSeq 保证单写者语义；不符抛 ConflictError。返回新的 lastSeq。 */
  append(taskId: TaskId, events: readonly TaskEvent[], expectedSeq: number): Promise<number>;
  read(taskId: TaskId, fromSeq?: number): AsyncIterable<Sequenced<TaskEvent>>;
  lastSeq(taskId: TaskId): Promise<number>;
  /** 订阅新事件，供宿主应用驱动 UI。 */
  subscribe(taskId: TaskId, cb: (e: Sequenced<TaskEvent>) => void): () => void;
}

export interface MemoryStore {
  put(memory: Memory): Promise<void>;
  get(id: MemoryId): Promise<Memory | null>;
  findBySubject(scope: Memory['scope'], subject: string, kind: Memory['kind']): Promise<readonly Memory[]>;
  /** 关键词/全文检索。向量检索走 VectorIndex，两路结果由 melon-memory 融合。 */
  search(query: MemoryQuery): Promise<readonly Scored<Memory>[]>;
  /** 标记 oldId 被 newId 替代。不物理删除。 */
  supersede(oldId: MemoryId, newId: MemoryId): Promise<void>;
  /** 命中后更新 lastUsedAt / useCount。 */
  touch(ids: readonly MemoryId[], at: number): Promise<void>;
  /**
   * 按来源任务删除 —— 支撑「忘掉关于 X 的一切」。
   *
   * 这是 `DeletionMotive = 'privacy'` 路径，**是物理删除，不是软删**，
   * 且必须一并移除对应的向量与 FTS 条目（见 docs/architecture.md §2.5）。
   * 其余场景（记忆冲突）走 `supersede`，不走这里。
   */
  forgetByTask(taskId: TaskId): Promise<number>;
}

export interface EpisodeStore {
  open(rootId: TaskId, at: number): Promise<EpisodeId>;
  append(id: EpisodeId, entry: Entry): Promise<void>;
  close(id: EpisodeId, at: number): Promise<void>;
  setSummary(id: EpisodeId, summary: EpisodeSummary): Promise<void>;
  get(id: EpisodeId): Promise<Episode | null>;
  list(rootId: TaskId): Promise<readonly Episode[]>;
  /** 读原文。压缩是有损的，但原文永远留着，可通过 read_artifact 取回。 */
  readEntries(id: EpisodeId, range?: { from: number; to: number }): Promise<readonly Entry[]>;
}

export interface ArtifactMeta {
  readonly ref: ArtifactRef;
  readonly taskId: TaskId;
  readonly mime: string;
  readonly bytes: number;
  readonly summary: string;
  readonly createdAt: number;
}

/**
 * 大结果的去处。**payload 不进上下文，也不该进主库** ——
 * 表里只存元信息，实体落文件系统或对象存储。
 */
export interface ArtifactStore {
  put(taskId: TaskId, data: Uint8Array | string, meta: { mime: string; summary: string }): Promise<ArtifactRef>;
  read(ref: ArtifactRef, range?: { offset: number; length: number }): Promise<Uint8Array>;
  stat(ref: ArtifactRef): Promise<ArtifactMeta | null>;
  listByTask(taskId: TaskId): Promise<readonly ArtifactMeta[]>;
}

export interface GrantStore {
  find(agentId: AgentId, toolId: string, scope: string): Promise<Grant | null>;
  put(grant: Grant): Promise<void>;
  /** 不传 scope 则撤销该工具的全部授权。 */
  revoke(agentId: AgentId, toolId: string, scope?: string): Promise<void>;
  /** 供设置页展示「我都始终允许过什么」—— scope 可读是这个功能的前提。 */
  listByAgent(agentId: AgentId): Promise<readonly Grant[]>;
}

export interface ScheduleStore {
  put(schedule: Schedule): Promise<void>;
  get(id: ScheduleId): Promise<Schedule | null>;
  /**
   * 到期该触发的。`status='active'` 且 `nextFireAt <= now`。
   *
   * 与 `TaskStore.listDue` 是两回事：那个唤醒的是挂起的任务实例，
   * 这个决定的是要不要新建一个任务。
   */
  listDue(now: number, limit: number): Promise<readonly Schedule[]>;
  /** 不传 status 则返回除 removed 外的全部 —— 界面默认不该看见已删的。 */
  list(agentId?: AgentId, status?: ScheduleStatus): Promise<readonly Schedule[]>;
  /**
   * 标记 oldId 被 newId 替代。**不物理删**（§2.5）——
   * 历史任务的 `trigger.ref` 还指着 oldId。
   */
  supersede(oldId: ScheduleId, newId: ScheduleId): Promise<void>;
}

/** 基础设施模块一次性提供全套存储。宿主只需注入这一个对象。 */
export interface StoreBundle {
  readonly tasks: TaskStore;
  readonly events: EventLog;
  readonly memories: MemoryStore;
  readonly episodes: EpisodeStore;
  readonly artifacts: ArtifactStore;
  readonly grants: GrantStore;
  readonly schedules: ScheduleStore;
  readonly vectors: VectorIndex;
  readonly purger: Purger;
  readonly archive: Archive;
  /** 跨多个 store 的原子写。单机 SQLite 下就是一个事务。 */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface VectorIndex {
  readonly dims: number;
  upsert(id: string, vector: Float32Array, meta?: Record<string, unknown>): Promise<void>;
  query(vector: Float32Array, k: number, filter?: Record<string, unknown>): Promise<readonly Scored<string>[]>;
  remove(id: string): Promise<void>;
}
