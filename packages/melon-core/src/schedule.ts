import type { AgentId, TaskId } from './ids.js';
import type { Budget, TaskKind } from './task.js';

/**
 * ─── 定时 ───
 * 见 docs/architecture.md §4.8。三条边界：
 * 1. 调度只决定「什么时候提交」，不认识 AgentEngine
 * 2. 算下一次触发时间是纯函数（时区/DST 是这块唯一真正难的部分）
 * 3. 不物理删 —— 历史任务通过 `trigger.ref` 指着 Schedule
 */

export type ScheduleId = string & { readonly __brand: 'ScheduleId' };
export const asScheduleId = (s: string): ScheduleId => s as ScheduleId;

/** 一天里的时刻。分开存而不是存「距零点的毫秒数」—— DST 那天这两者不等价。 */
export interface TimeOfDay {
  readonly hour: number;   // 0-23
  readonly minute: number; // 0-59
}

/** 0 = 周日，与 `Date.getDay()` 一致。 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 周期规则。
 *
 * 不用 cron 表达式：`0 9 * * 1-5` 对用户不可读，对代码也没更简单
 * （还得自己写 parser）。界面上能选出来的就这几种，直接建模。
 * 真需要 cron 时再加一个 `{ kind: 'cron'; expr: string }` 分支，不影响已有的。
 */
export type Recurrence =
  /** 只跑一次。`at` 是绝对时间戳，不受时区影响。 */
  | { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'daily'; readonly time: TimeOfDay; readonly tz: string }
  | { readonly kind: 'weekly'; readonly days: readonly Weekday[]; readonly time: TimeOfDay; readonly tz: string }
  /** 固定间隔，与时区无关。适合「每 15 分钟」这类轮询式任务。 */
  | { readonly kind: 'interval'; readonly everyMs: number };

/**
 * 停机期间错过的触发怎么办。
 *
 * - `skip`  —— 欠多少次都只跑一次（默认）
 * - `all`   —— 每一次都补跑
 *
 * 默认 `skip`：定时任务多半有对外副作用，关机一周回来补发七封周报
 * 比漏发七封糟得多，而且不可撤销（§4.8 边界三）。
 */
export type CatchUpMode = 'skip' | 'all';

export type ScheduleStatus = 'active' | 'paused' | 'removed';

/** 到点了原样提交的任务模板。故意不含 trigger —— 由调度器填 `{type:'schedule', ref}`。 */
export interface ScheduleTemplate {
  readonly agentId: AgentId;
  readonly kind: TaskKind;
  readonly goal: string;
  readonly budget?: Partial<Budget>;
}

export interface Schedule {
  readonly id: ScheduleId;
  /** 给人看的名字。留空时界面回落到 goal 的首行。 */
  readonly title: string;
  readonly template: ScheduleTemplate;
  readonly rule: Recurrence;
  readonly catchUp: CatchUpMode;
  readonly status: ScheduleStatus;
  /** 下一次该触发的时刻。`null` 表示不会再触发（一次性的跑完了，或已暂停/删除）。 */
  readonly nextFireAt: number | null;
  readonly lastFiredAt: number | null;
  readonly lastTaskId: TaskId | null;
  readonly fireCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 版本链。改时间或改目标时新建一条，旧的这里指向新的（§2.5 supersede）——
   * 要能回答「上周这个任务几点跑的」。
   */
  readonly supersededBy: ScheduleId | null;
}
