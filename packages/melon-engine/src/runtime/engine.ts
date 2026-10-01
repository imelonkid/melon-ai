import type {
  AgentEngine, ApprovalDecision, Effect, EpisodeStore, EventLog, Sequenced, Task, TaskEvent,
  TaskId, TaskSpec, TaskStore, ToolsetSnapshot,
} from '@melon-ai/core';
import { asTaskId } from '@melon-ai/core';
import { createTask, deriveChildBudget, resumeEffects } from '../task/index.js';
import { apply } from './apply.js';
import type { ApplyDeps } from './apply.js';
import { runEffect } from './effects.js';
import type { EffectDeps, Follow } from './effects.js';
import { KeyedMutex } from './mutex.js';

export interface EngineDeps extends ApplyDeps, Omit<EffectDeps, 'createChild' | 'scheduleWake'> {
  readonly episodes: EpisodeStore;
  readonly events: EventLog;
  readonly tasks: TaskStore;
  readonly toolset: () => ToolsetSnapshot;
  /** 轮询到期挂起任务的间隔。0 表示不轮询（测试里手动 tick）。 */
  readonly pollIntervalMs?: number;
}

/**
 * 运行时。
 *
 * 职责边界：
 * - **状态机是纯的**，在 `engine/task`
 * - **事务边界在 `apply`**：一个外部事件 + 它纯粹派生的所有事件 = 一个事务
 * - **I/O 在 `runEffect`**
 * - 本类负责把三者串起来，并保证同一任务的推进是串行的
 */
export class Runtime implements AgentEngine {
  private readonly mutex = new KeyedMutex();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 在跑的推进链。
   * `submit` 不能等整条链跑完（那会阻塞到任务结束），但测试和优雅关闭需要等 ——
   * 所以把 fire-and-forget 的 promise 收集起来，由 `drain()` 等。
   */
  private readonly inflight = new Set<Promise<unknown>>();
  private poller: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /**
   * 已停止。与 `running` 分开：没 start 过也能 submit/watch（测试这么用），
   * 但 stop 之后所有 watch 都得收尾 —— 否则还在等人的任务的 watch 会一直轮询：
   * 存储已关时每次轮询都抛错，存储还开着时进程永远退不出（§10 第 53 条）。
   */
  private stopped = false;
  private readonly waking = new Set<() => void>();

  constructor(private readonly deps: EngineDeps) {}

  // ─────────────────────────── 宿主 API ───────────────────────────

  async submit(spec: TaskSpec): Promise<Task> {
    const task = await this.create(spec);
    this.spawn(this.advance(task.id, { t: 'Started' }));
    return task;
  }

  /**
   * 等所有在跑的推进链结束。
   *
   * 宿主通常不需要它（靠 `watch` 看事件流即可），
   * 但测试和优雅关闭需要一个确定的收敛点。
   */
  async drain(maxRounds = 100): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if (this.inflight.size === 0) return;
      await Promise.allSettled([...this.inflight]);
    }
    throw new Error(`drain 未收敛：仍有 ${this.inflight.size} 条推进链在跑`);
  }

  private spawn(p: Promise<unknown>): void {
    const wrapped = p.finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
  }

  async get(id: TaskId): Promise<Task | null> {
    return this.deps.tasks.get(id);
  }

  async cancel(id: TaskId, reason?: string): Promise<void> {
    await this.advance(id, reason === undefined ? { t: 'Cancelled' } : { t: 'Cancelled', reason });
  }

  async resolveApproval(id: TaskId, callId: string, decision: ApprovalDecision): Promise<void> {
    const task = await this.deps.tasks.get(id);
    await this.advance(id, { t: 'ApprovalResolved', callId: callId as never, decision });
    // 用户的决定要进审计：此前只记了「需要询问」，「是谁、在什么时候批的」只在任务的事件日志里，
    // 任务按保留期清掉就没了
    if (this.deps.audit && task) {
      await this.deps.audit.record({
        at: this.deps.now(),
        actor: { kind: 'user', id: 'user' },
        action: 'approval.decide',
        resource: { kind: 'tool-call', ref: callId },
        outcome: decision === 'deny' ? 'deny' : 'allow',
        traceId: task.trace.traceId,
        spanId: task.trace.spanId,
        taskId: task.id,
        dimensions: { toolId: task.pendingCall?.toolId ?? 'unknown', decision },
        basis: { decidedBy: 'user', decision },
      });
    }
  }

  /**
   * 订阅任务事件。
   *
   * 先订阅再回放，回放时按 seq 去重 —— 反过来（先回放再订阅）会漏掉
   * 两个动作之间新追加的事件。
   */
  async *watch(id: TaskId, fromSeq = 0): AsyncIterable<Sequenced<TaskEvent>> {
    const buffer: Sequenced<TaskEvent>[] = [];
    let notify: (() => void) | undefined;
    const off = this.deps.events.subscribe(id, (e) => {
      buffer.push(e);
      notify?.();
    });
    try {
      let lastSeq = fromSeq;
      for await (const row of this.deps.events.read(id, fromSeq)) {
        lastSeq = row.seq;
        yield row;
      }
      for (;;) {
        while (buffer.length > 0) {
          const row = buffer.shift()!;
          if (row.seq <= lastSeq) continue; // 回放已覆盖
          lastSeq = row.seq;
          yield row;
        }
        if (this.stopped) return;
        const task = await this.deps.tasks.get(id);
        if (task && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state) && buffer.length === 0) return;
        await new Promise<void>((r) => {
          notify = r;
          this.waking.add(r);
          setTimeout(r, 50);
        });
        if (notify) this.waking.delete(notify);
        notify = undefined;
      }
    } finally {
      off();
    }
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    await this.recover();
    const iv = this.deps.pollIntervalMs ?? 1000;
    if (iv > 0) this.poller = setInterval(() => void this.tick(), iv);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    // 叫醒所有在等的 watch，让它们看到 stopped 后收尾
    for (const wake of this.waking) wake();
    this.waking.clear();
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * 崩溃恢复。
   *
   * 不回放整条日志 —— 靠 `resumeEffects(task)` 从静止状态直接推出「运行时欠什么」。
   * 这是事务边界规则换来的简化（见 apply.ts 的说明）。
   */
  async recover(): Promise<number> {
    const stuck = await this.deps.tasks.listByState(
      ['PENDING', 'PLANNING', 'ADMITTING', 'EXECUTING', 'SUSPENDED'], 1000,
    );
    for (const task of stuck) {
      const effects = resumeEffects(task);
      this.deps.logger.log('info', '恢复任务', {
        taskId: task.id, state: task.state, effects: effects.length,
      });
      for (const eff of effects) {
        if (eff.k === 'Emit') this.spawn(this.advance(task.id, eff.event));
        else this.spawn(this.drive(task.id, [eff]));
      }
    }
    return stuck.length;
  }

  /** 唤醒到期的挂起任务。 */
  async tick(now = this.deps.now()): Promise<number> {
    const due = await this.deps.tasks.listDue(now, 100);
    for (const t of due) this.spawn(this.advance(t.id, { t: 'Resumed' }));
    return due.length;
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private async create(spec: TaskSpec, parent?: Task): Promise<Task> {
    const id = asTaskId(this.deps.ids.next('task'));
    const now = this.deps.now();
    const rootId = parent ? parent.rootId : id;
    const episodeId = parent
      ? parent.episodeId // 一棵任务树共享一份 L2 工作记忆
      : await this.deps.episodes.open(rootId, now);
    const task = createTask({
      id,
      spec: parent ? { ...spec, budget: deriveChildBudget(parent.budget) } : spec,
      rootId,
      episodeId,
      toolset: this.deps.toolset(),
      trace: parent ? this.deps.tracer.child(parent.trace) : this.deps.tracer.root(),
      now,
    });
    await this.deps.tasks.create(task);
    await this.deps.events.append(id, [{ t: 'Created', spec }], 0);
    return task;
  }

  /**
   * 原子推进一批事件，并把它产生的 I/O effect 执行到底。
   *
   * 批次必须整体提交 —— 见 apply.ts 的事务边界规则。
   */
  private async advance(id: TaskId, input: TaskEvent | readonly TaskEvent[]): Promise<void> {
    const r = await this.mutex.run(id, () => apply(this.deps, id, input));
    // 没执行的调用（参数不合法、检查没过、准入拒绝、用户拒绝）由状态机直接推出 Observed，不经过工具执行 ——
    // 执行过的那条路径会把结果写进 episode，这里得补上，否则下一次问模型时它看不到原因，只会原样重试
    const ran = new Set(r.committed.filter((e) => e.t === 'ToolCallFinished').map((e) => (e as { callId: string }).callId));
    for (const e of r.committed) {
      if (e.t !== 'Observed' || (e.callId && ran.has(e.callId))) continue;
      await this.deps.episodes.append(r.task.episodeId, { kind: 'observation', text: e.summary, at: this.deps.now() });
    }
    await this.drive(id, r.deferred);
  }

  /** 执行 I/O effect，把后续事件递归推进。 */
  private async drive(id: TaskId, effects: readonly Effect[]): Promise<void> {
    const effectDeps: EffectDeps = {
      ...this.deps,
      createChild: async (parentId, spec) => {
        const parent = await this.deps.tasks.get(parentId);
        if (!parent) throw new Error(`父任务不存在：${parentId}`);
        const child = await this.create(spec, parent);
        this.spawn(this.advance(child.id, { t: 'Started' }));
        return child;
      },
      scheduleWake: (taskId, at) => this.wake(taskId, at),
    };
    for (const eff of effects) {
      let follows: readonly Follow[];
      try {
        follows = await runEffect(effectDeps, eff);
      } catch (e) {
        this.deps.logger.log('error', `effect ${eff.k} 执行失败：${e instanceof Error ? e.message : String(e)}`, {
          taskId: id, effect: eff.k,
        });
        // 不静默吞掉：让任务失败，否则会永久卡在中间状态
        follows = [{ taskId: id, events: [{
          t: 'Settled',
          outcome: { status: 'FAILED', reason: `effect ${eff.k} 失败：${e instanceof Error ? e.message : String(e)}` },
        }] }];
      }
      for (const f of follows) {
        if (f.events.length > 0) await this.advance(f.taskId, f.events);
      }
    }
  }

  private wake(taskId: TaskId, at: number): void {
    const delay = Math.max(0, at - this.deps.now());
    const prev = this.timers.get(taskId);
    if (prev) clearTimeout(prev);
    this.timers.set(taskId, setTimeout(() => {
      this.timers.delete(taskId);
      this.spawn(this.advance(taskId, { t: 'Resumed' }));
    }, delay));
  }
}
