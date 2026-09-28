import type {
  Effect, EventLog, Task, TaskEvent, TaskStore,
} from '@melon-ai/core';
import { isResting, reduce } from '@melon-ai/task';

export interface ApplyDeps {
  readonly tasks: TaskStore;
  readonly events: EventLog;
  readonly now: () => number;
  readonly transaction: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface ApplyResult {
  readonly task: Task;
  /** 提交后才执行的 I/O 型 effect。 */
  readonly deferred: readonly Effect[];
  /** 本次事务实际落盘的事件序列。 */
  readonly committed: readonly TaskEvent[];
}

const MAX_CASCADE = 32;

/**
 * 原子推进一批。
 *
 * ── 事务边界规则（architecture.md §3.1）──
 * **一个事务 = 一个原子输入批次 + 它纯粹派生出的所有事件。**
 *
 * 「原子输入批次」是：一个宿主触发的事件，**或者**一个 effect 产出的全部事件。
 * 后者很关键 —— `InvokeTool` 产出 `[ToolCallStarted, ToolCallFinished, Observed]`，
 * 三者必须同批提交：拆开会让 `OBSERVING` 成为静止状态，
 * 而崩在 `ToolCallFinished` 与 `Observed` 之间会把工具结果彻底丢掉。
 *
 * `Emit` 型 effect 是「纯粹派生」——不需要 I/O，只是状态机把一个事实推导成下一个事实
 * （`Observed` → `BudgetExhausted` → `Settled`）。它们在同一个事务内被吸收。
 *
 * 需要 I/O 的 effect（`CallPlanner` / `Admit` / `InvokeTool` / …）推迟到提交之后。
 *
 * 这条规则换来的是：**静止状态的集合是有限且明确的**，
 * 于是崩溃恢复可以简化成 `resumeEffects(task)` 一个纯函数，
 * 不必回放整条日志去重建「运行时当时欠什么」。
 */
export async function apply(
  deps: ApplyDeps,
  taskId: Task['id'],
  input: TaskEvent | readonly TaskEvent[],
): Promise<ApplyResult> {
  return deps.transaction(async () => {
    const loaded = await deps.tasks.get(taskId);
    if (!loaded) throw new Error(`任务不存在：${taskId}`);

    let task = loaded;
    const expectedVersion = loaded.version;
    const expectedSeq = await deps.events.lastSeq(taskId);

    const committed: TaskEvent[] = [];
    const deferred: Effect[] = [];
    let queue: TaskEvent[] = Array.isArray(input) ? [...input] : [input as TaskEvent];
    let rounds = 0;

    while (queue.length > 0) {
      if (++rounds > MAX_CASCADE) {
        throw new Error(`事件级联超过 ${MAX_CASCADE} 轮，疑似状态机自环：${taskId}`);
      }
      const e = queue.shift()!;
      const r = reduce(task, e, { now: deps.now() });
      task = r.task;
      committed.push(e);

      for (const eff of r.effects) {
        if (eff.k === 'Emit') queue.push(eff.event);
        else deferred.push(eff);
      }
    }

    // 落盘前自检：静止状态集合是这套恢复策略的前提，破了要立刻暴露
    if (!isResting(task.state)) {
      throw new Error(
        `任务 ${taskId} 将以非静止状态 ${task.state} 落盘 —— 违反事务边界规则。` +
        `说明某个 reducer 分支返回了需要 I/O 的 effect 却把状态停在了中间态。`,
      );
    }

    await deps.events.append(taskId, committed, expectedSeq);
    await deps.tasks.save(task, expectedVersion);

    return { task, deferred, committed };
  });
}
