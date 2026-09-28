import type { Effect, Task, TaskState } from '@melon-ai/core';

/**
 * 崩溃恢复：给定一个已落盘的任务，要重发哪些 effect 才能继续推进。
 *
 * 这**不是** reducer 的重复。两者回答不同的问题：
 * - `reduce(task, event)` —— 「收到这个事件会发生什么」
 * - `resumeEffects(task)` —— 「从这个静止状态出发，运行时还欠一个什么动作」
 *
 * 能这么写的前提是**静止状态的集合是有限且明确的**：
 * 运行时把「一个外部事件 + 它纯粹派生出的所有事件」作为一个事务提交，
 * 所以 `OBSERVING` 这类中间状态永远不会作为静止状态落盘（见 architecture.md §3.1）。
 *
 * 所有重发的 effect 都必须幂等 —— 这正是 §2.3 对 Effect 的要求。
 */
export function resumeEffects(task: Task): readonly Effect[] {
  switch (task.state) {
    case 'PENDING':
      // 还没开始，运行时欠一次 Started
      return [{ k: 'Emit', taskId: task.id, event: { t: 'Started' } }];

    case 'PLANNING':
      return [{ k: 'CallPlanner', taskId: task.id }];

    case 'ADMITTING':
      // 准入是纯判定 + 一条审计，重跑安全（会多一条审计记录，那是诚实的历史）
      return task.pendingCall
        ? [{ k: 'Admit', taskId: task.id, call: task.pendingCall }]
        : [];

    case 'EXECUTING':
      // 靠 IdempotencyStore 兜住「不要真的再发一次邮件」
      return task.pendingCall
        ? [{ k: 'InvokeTool', taskId: task.id, call: task.pendingCall }]
        : [];

    case 'AWAITING_APPROVAL':
      // 等人。可能等几小时，不该做任何事
      return [];

    case 'SUSPENDED':
      return task.deadline !== undefined
        ? [{ k: 'ScheduleWake', taskId: task.id, at: task.deadline }]
        : [];

    case 'OBSERVING':
      // 按事务边界规则不该出现在这里；出现了说明有 bug，宁可停下也别乱猜
      throw new Error(
        `任务 ${task.id} 以 OBSERVING 落盘 —— 违反事务边界规则（architecture.md §3.1）。` +
        `OBSERVING 只应作为事务内的中间状态存在。`,
      );

    case 'SUCCEEDED':
    case 'FAILED':
    case 'CANCELLED':
      return [];
  }
}

/** 静止状态：可以作为持久状态落盘的集合。 */
export const RESTING_STATES: readonly TaskState[] = [
  'PENDING', 'PLANNING', 'ADMITTING', 'EXECUTING', 'AWAITING_APPROVAL', 'SUSPENDED',
  'SUCCEEDED', 'FAILED', 'CANCELLED',
];

export const isResting = (s: TaskState): boolean => RESTING_STATES.includes(s);
