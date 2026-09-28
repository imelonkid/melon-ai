import type { Effect, ReduceResult, Task, TaskEvent } from '@melon-ai/core';

export type Reducer = (task: Task, event: TaskEvent, opts: { now: number }) => ReduceResult;

export interface Step {
  readonly event: TaskEvent;
  readonly state: Task['state'];
  readonly effects: readonly Effect[];
}

export interface DriveResult {
  readonly task: Task;
  readonly steps: readonly Step[];
  /** 全部 effect 的扁平序列，方便断言「有没有发生过某个副作用」。 */
  readonly effects: readonly Effect[];
  readonly states: readonly Task['state'][];
}

/**
 * 依次把事件喂给 reducer，记录每一步的状态与副作用。
 *
 * 这是状态机测试的主力工具：**不碰模型、不碰数据库、不读时钟**，
 * 一条断言就能表达「这串事件应该走出这串状态」。
 */
export function drive(
  reduce: Reducer,
  initial: Task,
  events: readonly TaskEvent[],
  now = 0,
): DriveResult {
  let task = initial;
  const steps: Step[] = [];
  for (const event of events) {
    const r = reduce(task, event, { now });
    task = r.task;
    steps.push({ event, state: r.task.state, effects: r.effects });
  }
  return {
    task,
    steps,
    effects: steps.flatMap((s) => [...s.effects]),
    states: steps.map((s) => s.state),
  };
}

/** 从 effects 里挑出 Emit 的事件 —— reducer 派生的事件要接着喂回去。 */
export function emitted(effects: readonly Effect[]): readonly TaskEvent[] {
  return effects.flatMap((e) => (e.k === 'Emit' ? [e.event] : []));
}

/**
 * 跑到收敛：把 reducer 派生的事件自动喂回，直到没有新事件或到达终态。
 * 上限 `maxRounds` 防止测试里写出无限循环。
 */
export function settle(
  reduce: Reducer,
  initial: Task,
  events: readonly TaskEvent[],
  now = 0,
  maxRounds = 20,
): DriveResult {
  let task = initial;
  const steps: Step[] = [];
  let queue = [...events];
  let rounds = 0;
  while (queue.length > 0) {
    if (++rounds > maxRounds) throw new Error(`settle 未收敛，超过 ${maxRounds} 轮`);
    const event = queue.shift()!;
    const r = reduce(task, event, { now });
    task = r.task;
    steps.push({ event, state: r.task.state, effects: r.effects });
    queue = [...emitted(r.effects), ...queue];
  }
  return {
    task,
    steps,
    effects: steps.flatMap((s) => [...s.effects]),
    states: steps.map((s) => s.state),
  };
}
