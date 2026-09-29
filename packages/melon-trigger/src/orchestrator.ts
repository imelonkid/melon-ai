import type {
  Clock, IdGen, Logger, Schedule, ScheduleId, ScheduleStatus, ScheduleStore,
  ScheduleTemplate, Recurrence, CatchUpMode, TaskId, AgentId, TaskSpec,
} from '@melon-ai/core';
import { asScheduleId } from '@melon-ai/core';
import { advancePast, nextFireAt } from './recurrence.js';

/** `catchUp:'all'` 的上限。停机半年的「每分钟」规则不该一次提交几十万个任务。 */
const MAX_CATCH_UP = 20;

/**
 * 提交一个任务。**调度器不认识 AgentEngine**（§4.8 边界一）——
 * 它只拿这个回调，由宿主接线。这样本包只依赖 core，也让调度能被单独测。
 */
export type TaskSubmitter = (spec: TaskSpec) => Promise<{ readonly id: TaskId }>;

export interface SchedulerDeps {
  readonly store: ScheduleStore;
  readonly submit: TaskSubmitter;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
}

export interface CreateScheduleInput {
  readonly title: string;
  readonly template: ScheduleTemplate;
  readonly rule: Recurrence;
  readonly catchUp?: CatchUpMode;
}

/** 可改的字段。改任何一项都走版本链，不原地改（§2.5）。 */
export interface UpdateScheduleInput {
  readonly title?: string;
  readonly template?: ScheduleTemplate;
  readonly rule?: Recurrence;
  readonly catchUp?: CatchUpMode;
}

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** 同 tick 内重入会把同一个 schedule 触发两次。 */
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  // ─────────────────────────── 宿主 API ───────────────────────────

  async create(input: CreateScheduleInput): Promise<Schedule> {
    const now = this.deps.clock.now();
    const schedule: Schedule = {
      id: asScheduleId(this.deps.ids.next('sched')),
      title: input.title,
      template: input.template,
      rule: input.rule,
      catchUp: input.catchUp ?? 'skip',
      status: 'active',
      nextFireAt: nextFireAt(input.rule, now),
      lastFiredAt: null,
      lastTaskId: null,
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
    };
    await this.deps.store.put(schedule);
    this.deps.logger.log('info', '新建定时任务', {
      scheduleId: schedule.id, nextFireAt: schedule.nextFireAt,
    });
    this.rearm();
    return schedule;
  }

  /**
   * 改配置 = 新建一条 + 旧的 supersede 指向它（§2.5 版本链）。
   *
   * 不原地改的理由是要能回答「上周这个任务几点跑的」—— 历史任务通过
   * `trigger.ref` 指着当时那一条，原地改会让历史记录集体失真。
   */
  async update(id: ScheduleId, patch: UpdateScheduleInput): Promise<Schedule> {
    const prev = await this.require(id);
    const now = this.deps.clock.now();
    const rule = patch.rule ?? prev.rule;
    const next: Schedule = {
      ...prev,
      id: asScheduleId(this.deps.ids.next('sched')),
      title: patch.title ?? prev.title,
      template: patch.template ?? prev.template,
      rule,
      catchUp: patch.catchUp ?? prev.catchUp,
      status: 'active',
      // 规则变了就重算；只改标题时保持原有节奏，别把下一次触发推后
      nextFireAt: patch.rule ? nextFireAt(rule, now) : prev.nextFireAt,
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
    };
    await this.deps.store.put(next);
    await this.deps.store.supersede(prev.id, next.id);
    this.deps.logger.log('info', '定时任务已更新', { from: prev.id, to: next.id });
    this.rearm();
    return next;
  }

  async setStatus(id: ScheduleId, status: Exclude<ScheduleStatus, 'active'>): Promise<Schedule> {
    const prev = await this.require(id);
    const next: Schedule = {
      ...prev, status, nextFireAt: null, updatedAt: this.deps.clock.now(),
    };
    await this.deps.store.put(next);
    this.deps.logger.log('info', status === 'paused' ? '定时任务已暂停' : '定时任务已删除', { scheduleId: id });
    this.rearm();
    return next;
  }

  async resume(id: ScheduleId): Promise<Schedule> {
    const prev = await this.require(id);
    if (prev.status === 'removed') {
      throw new Error(`定时任务 ${id} 已删除，不能恢复`);
    }
    const now = this.deps.clock.now();
    const next: Schedule = {
      ...prev, status: 'active', nextFireAt: nextFireAt(prev.rule, now), updatedAt: now,
    };
    await this.deps.store.put(next);
    this.rearm();
    return next;
  }

  list(agentId?: AgentId, status?: ScheduleStatus): Promise<readonly Schedule[]> {
    return this.deps.store.list(agentId, status);
  }

  get(id: ScheduleId): Promise<Schedule | null> {
    return this.deps.store.get(id);
  }

  // ─────────────────────────── 驱动 ───────────────────────────

  /**
   * 跑一轮：把所有到期的 schedule 触发掉。返回这一轮提交的任务数。
   *
   * 公开出来是为了测试和宿主自己控制节奏 —— `start()` 只是给它接了个定时器。
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const now = this.deps.clock.now();
      const due = await this.deps.store.listDue(now, 100);
      let fired = 0;
      for (const s of due) {
        fired += await this.fire(s, now);
      }
      return fired;
    } finally {
      this.ticking = false;
    }
  }

  start(tickMs = 30_000): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      void this.tick()
        .catch((e: unknown) => this.deps.logger.log('error', '定时轮询失败', { error: String(e) }))
        .finally(() => {
          if (this.running) this.timer = setTimeout(loop, tickMs);
        });
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private async require(id: ScheduleId): Promise<Schedule> {
    const s = await this.deps.store.get(id);
    if (!s) throw new Error(`定时任务不存在：${id}`);
    if (s.supersededBy) throw new Error(`定时任务 ${id} 已被 ${s.supersededBy} 取代`);
    return s;
  }

  /**
   * 触发一条。
   *
   * 先推进 `nextFireAt` 再 submit —— 反过来的话 submit 抛错会让这条
   * 一直停在到期状态，下一轮又试，变成刷屏式重试。
   */
  private async fire(s: Schedule, now: number): Promise<number> {
    const base = s.nextFireAt ?? s.lastFiredAt ?? now;
    const { missed, next } = advancePast(s.rule, base, now);
    // skip：欠多少次都只跑一次。定时任务多半有对外副作用，关机一周回来
    // 发七封周报比漏发七封糟得多，而且不可撤销（§4.8 边界三）
    const runs = s.catchUp === 'all' ? Math.min(Math.max(missed, 1), MAX_CATCH_UP) : 1;

    await this.deps.store.put({ ...s, nextFireAt: next, updatedAt: now });

    let lastTaskId: TaskId | null = null;
    let fired = 0;
    for (let i = 0; i < runs; i++) {
      try {
        const task = await this.deps.submit({
          agentId: s.template.agentId,
          kind: s.template.kind,
          goal: s.template.goal,
          // 一次触发 = 一个新任务 = 一个新 trace（§2.6）。ref 挂回 Schedule，
          // 「这个定时任务历史上跑出来的所有任务」用它反查
          trigger: { type: 'schedule', ref: s.id },
          ...(s.template.budget ? { budget: s.template.budget } : {}),
        });
        lastTaskId = task.id;
        fired += 1;
      } catch (e) {
        this.deps.logger.log('error', '定时任务提交失败', {
          scheduleId: s.id, error: String(e),
        });
      }
    }

    if (fired > 0) {
      await this.deps.store.put({
        ...s,
        nextFireAt: next,
        lastFiredAt: now,
        lastTaskId,
        fireCount: s.fireCount + fired,
        updatedAt: now,
      });
      this.deps.logger.log('info', '定时任务已触发', {
        scheduleId: s.id, missed, nextFireAt: next,
      });
    }
    return fired;
  }

  /** 配置变了就让下一轮 tick 早点来 —— 否则新建的「1 分钟后」要等满一个轮询周期。 */
  private rearm(): void {
    if (!this.running) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
  }
}
