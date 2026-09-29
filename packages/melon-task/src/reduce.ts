import type {
  Effect, GuardThresholds, Outcome, ReduceResult, Task, TaskEvent, TaskState,
} from '@melon-ai/core';
import { DEFAULT_GUARDS, IllegalTransitionError, TERMINAL_STATES } from '@melon-ai/core';
import { lookup } from './transitions.js';
import { addUsage, exhausted } from './budget.js';
import { detectLoop, detectNoProgress, observe, recordCall } from './guards.js';

export interface ReduceOptions {
  readonly now: number;
  readonly guards?: GuardThresholds;
}

/**
 * 清除 `pendingCall`。
 *
 * `Task.pendingCall` 的契约是「state=AWAITING_APPROVAL 时非空」，
 * 但初版 reducer 从不清除它 —— 任务跑完后它还挂着，宿主按它查找待审批任务
 * 会找到已完成的任务，然后对终态发 ApprovalResolved 而抛 IllegalTransitionError。
 * 这是集成 Jolly 时才暴露出来的。
 *
 * `exactOptionalPropertyTypes` 下不能赋 undefined，必须省略这个键。
 */
const clearPending = (t: Task): Task => {
  const { pendingCall: _dropped, ...rest } = t;
  return rest;
};

const settle = (taskId: Task['id'], outcome: Outcome): Effect => ({
  k: 'Emit',
  taskId,
  event: { t: 'Settled', outcome },
});

/**
 * 纯状态机 reducer。
 *
 * **不做任何 I/O**：不碰模型、不碰数据库、不读时钟（`now` 由调用方传入）。
 * 副作用以描述形式返回，由 EffectRunner 执行。
 *
 * 崩溃恢复的规则就是「重新 reduce 最后一条事件、重跑它产生的 effects」——
 * 所以**所有 Effect 必须幂等**。
 */
export function reduce(task: Task, event: TaskEvent, opts: ReduceOptions): ReduceResult {
  const g = opts.guards ?? DEFAULT_GUARDS;

  if (TERMINAL_STATES.includes(task.state)) {
    throw new IllegalTransitionError(task.state, event.t);
  }
  const transition = lookup(task.state, event.t);
  if (!transition) throw new IllegalTransitionError(task.state, event.t);

  const patch = (next: Partial<Task>, state?: TaskState, drop = false): Task => {
    const s = state ?? (transition.to === 'derived' ? task.state : transition.to);
    if (transition.to === 'derived' && transition.allowed && !transition.allowed.includes(s)) {
      throw new IllegalTransitionError(`${task.state}(derived)`, `${event.t}->${s}`);
    }
    const base = { ...task, ...next, state: s, updatedAt: opts.now, version: task.version + 1 };
    return drop ? clearPending(base) : base;
  };

  switch (event.t) {
    case 'Created':
      return { task, effects: [] };

    case 'Started':
      return { task: patch({}), effects: [{ k: 'CallPlanner', taskId: task.id }] };

    case 'SkillsInjected':
      return { task: patch({}), effects: [{ k: 'CallPlanner', taskId: task.id }] };

    case 'PlanProduced': {
      const withUsage = addUsage(task.usage, {
        steps: 1,
        tokens: event.usage.inputTokens + event.usage.outputTokens,
        ...(event.usage.costUSD !== undefined ? { costUSD: event.usage.costUSD } : {}),
      });
      const step = event.step;
      switch (step.kind) {
        case 'skill_query':
          return {
            task: patch({ usage: withUsage }, 'PLANNING', true),
            effects: [{ k: 'RecallSkills', taskId: task.id, query: step.query }],
          };
        case 'tool_call': {
          // 先记入守卫窗口，再判循环 —— 循环要拦在执行之前
          const guard = recordCall(task.guard, step.call, g);
          const looping = detectLoop(guard, g);
          if (looping !== null) {
            // 不进准入 —— 循环要拦在执行之前，留在 PLANNING 并发 LoopDetected
            return {
              task: patch({ usage: withUsage, guard }, 'PLANNING'),
              effects: [
                { k: 'Emit', taskId: task.id,
                  event: { t: 'LoopDetected', argsHash: looping, times: g.loopRepeats } },
              ],
            };
          }
          return {
            task: patch({ usage: withUsage, guard, pendingCall: step.call }, 'ADMITTING'),
            effects: [{ k: 'Admit', taskId: task.id, call: step.call }],
          };
        }
        case 'spawn':
          return {
            task: patch({ usage: withUsage, waitingFor: [] }, 'SUSPENDED', true),
            effects: [{ k: 'SpawnChildren', parentId: task.id, specs: step.specs }],
          };
        case 'final':
          return {
            task: patch({ usage: withUsage }, 'PLANNING', true),
            effects: [settle(task.id, { status: 'SUCCEEDED', answer: step.answer })],
          };
      }
    }

    case 'AdmissionResolved': {
      const call = task.pendingCall;
      switch (event.decision) {
        case 'allow':
          if (!call) throw new IllegalTransitionError(task.state, 'AdmissionResolved(allow) 无 pendingCall');
          return {
            task: patch({}, 'EXECUTING'),
            effects: [{ k: 'InvokeTool', taskId: task.id, call }],
          };
        case 'ask':
          if (!call) throw new IllegalTransitionError(task.state, 'AdmissionResolved(ask) 无 pendingCall');
          return {
            task: patch({}, 'AWAITING_APPROVAL'),
            effects: [{
              k: 'AskUser', taskId: task.id,
              request: { callId: event.callId, toolId: call.toolId, risk: event.risk, summary: event.reason },
            }],
          };
        case 'deny':
          // 拒绝不是错误，是给模型的信息 —— 当成一次 observation 回喂，让它改道
          return {
            task: patch({}, 'OBSERVING', true),
            effects: [{
              k: 'Emit', taskId: task.id,
              event: { t: 'Observed', callId: event.callId, summary: `准入拒绝：${event.reason}` },
            }],
          };
      }
    }

    case 'ApprovalRequested':
      return { task: patch({}), effects: [] };

    case 'ApprovalResolved': {
      if (event.decision === 'deny') {
        return {
          task: patch({}, 'OBSERVING', true),
          effects: [{
            k: 'Emit', taskId: task.id,
            event: { t: 'Observed', callId: event.callId, summary: '用户拒绝了这次操作。' },
          }],
        };
      }
      const call = task.pendingCall;
      if (!call) throw new IllegalTransitionError(task.state, 'ApprovalResolved 无 pendingCall');
      return {
        task: patch({}, 'EXECUTING'),
        effects: [{ k: 'InvokeTool', taskId: task.id, call }],
      };
    }

    case 'ToolCallStarted':
      return { task: patch({}), effects: [] };

    case 'ToolCallFinished':
      return {
        task: patch({
          usage: addUsage(task.usage, event.meta.metrics.costUSD !== undefined
            ? { costUSD: event.meta.metrics.costUSD } : {}),
        }, undefined, true),
        effects: [],
      };

    case 'Observed': {
      // 按内容判断进展：同一句话重复出现就是原地打转，不管参数换没换
      const guard = observe(task.guard, event.summary);
      const dim = exhausted({ ...task, guard }, opts.now);
      if (dim) {
        return {
          task: patch({ guard }, 'OBSERVING'),
          effects: [{ k: 'Emit', taskId: task.id, event: { t: 'BudgetExhausted', dimension: dim } }],
        };
      }
      if (detectNoProgress(guard, g)) {
        return {
          task: patch({ guard }, 'OBSERVING'),
          effects: [{ k: 'Emit', taskId: task.id, event: { t: 'NoProgress', steps: guard.stagnantSteps } }],
        };
      }
      return {
        task: patch({ guard }, 'PLANNING'),
        effects: [{ k: 'CallPlanner', taskId: task.id }],
      };
    }

    case 'LoopDetected':
      // 注入一条纠偏 observation，不终止任务 —— 给模型一次换路的机会
      return {
        task: patch({ guard: { recentCalls: [], stagnantSteps: task.guard.stagnantSteps } }, 'OBSERVING'),
        effects: [{
          k: 'Emit', taskId: task.id,
          event: {
            t: 'Observed',
            summary: `你已连续 ${event.times} 次用相同参数调用同一个工具，结果不会改变。换一种方法，或向用户说明卡在哪里。`,
          },
        }],
      };

    case 'NoProgress':
      return {
        task: patch({}, 'OBSERVING'),
        effects: [settle(task.id, {
          status: 'FAILED',
          reason: `连续 ${event.steps} 步没有进展，已停止并需要用户介入。`,
        })],
      };

    case 'BudgetExhausted':
      return {
        task: patch({}, 'OBSERVING'),
        effects: [settle(task.id, { status: 'FAILED', reason: `预算耗尽：${event.dimension}` })],
      };

    case 'ChildSpawned':
      return {
        task: patch({ waitingFor: [...(task.waitingFor ?? []), event.childId] }),
        effects: [],
      };

    case 'ChildSettled': {
      const remaining = (task.waitingFor ?? []).filter((id) => id !== event.childId);
      if (remaining.length > 0) {
        return { task: patch({ waitingFor: remaining }, 'SUSPENDED'), effects: [] };
      }
      return {
        task: patch({ waitingFor: [] }, 'PLANNING'),
        effects: [{ k: 'CallPlanner', taskId: task.id }],
      };
    }

    case 'Suspended':
      return {
        task: { ...task, state: 'SUSPENDED', updatedAt: opts.now, version: task.version + 1 },
        effects: event.until !== undefined
          ? [{ k: 'ScheduleWake', taskId: task.id, at: event.until }]
          : [],
      };

    case 'Resumed':
      return { task: patch({}), effects: [{ k: 'CallPlanner', taskId: task.id }] };

    case 'Compacted':
      return { task: patch({}), effects: [] };

    case 'Cancelled':
      return {
        task: patch({ outcome: { status: 'CANCELLED', ...(event.reason !== undefined ? { reason: event.reason } : {}) } }, 'CANCELLED', true),
        effects: task.parentId !== undefined
          ? [{ k: 'NotifyParent', parentId: task.parentId, childId: task.id, outcome: { status: 'CANCELLED' } }]
          : [],
      };

    case 'Settled': {
      const effects: Effect[] = [];
      if (task.parentId !== undefined) {
        effects.push({ k: 'NotifyParent', parentId: task.parentId, childId: task.id, outcome: event.outcome });
      }
      // 任务收敛后做内务：压缩本次 episode、把事实提升进 L1
      effects.push({ k: 'Compact', taskId: task.id, episodeId: task.episodeId });
      effects.push({ k: 'PromoteMemory', taskId: task.id, episodeId: task.episodeId });
      return { task: patch({ outcome: event.outcome }, event.outcome.status, true), effects };
    }
  }
}
