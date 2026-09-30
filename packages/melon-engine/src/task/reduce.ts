import type {
  Effect, GuardThresholds, Outcome, ReduceResult, Task, TaskEvent, TaskState,
} from '@melon-ai/core';
import { DEFAULT_GUARDS, GRANTABLE_RISKS, IllegalTransitionError, TERMINAL_STATES } from '@melon-ai/core';
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
 * 这是接第一个宿主时才暴露出来的。
 *
 * `exactOptionalPropertyTypes` 下不能赋 undefined，必须省略这个键。
 */
const clearPending = (t: Task): Task => {
  const { pendingCall: _dropped, ...rest } = t;
  return rest;
};

/** 用户拒绝后回喂给模型的话。 */
const DENIED_SUMMARY = '用户拒绝了这次操作，它没有执行。不要再请求同样的操作，也不要用文字再征求一次确认；直接告诉用户没有执行，或者换一种不需要这个操作的办法。';

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
          // 用户拒绝过的同一个操作：不进准入、不再问用户（规则保证，不指望模型自觉）
          if ((task.denied ?? []).includes(step.call.toolId)) {
            return {
              task: patch({ usage: withUsage }, 'PLANNING'),
              effects: [{ k: 'Emit', taskId: task.id, event: { t: 'RepeatDenied', toolId: step.call.toolId, times: (task.deniedRepeats ?? 0) + 1 } }],
            };
          }
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
          const called = task.toolsCalled ?? [];
          return {
            task: patch({
              usage: withUsage, guard, pendingCall: step.call, queuedCalls: step.then ?? [],
              ...(called.includes(step.call.toolId) ? {} : { toolsCalled: [...called, step.call.toolId] }),
            }, 'ADMITTING'),
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
        case 'abort':
          // 没做成就是没做成：记 FAILED，原因原样给用户，不能显示成「已完成」
          return {
            task: patch({ usage: withUsage }, 'PLANNING', true),
            effects: [settle(task.id, { status: 'FAILED', reason: step.reason })],
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
              request: {
                callId: event.callId, toolId: call.toolId, risk: event.risk, summary: event.reason,
                canAlways: GRANTABLE_RISKS.includes(event.risk),
              },
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
        const key = task.pendingCall ? task.pendingCall.toolId : null;
        return {
          task: patch(key && !(task.denied ?? []).includes(key) ? { denied: [...(task.denied ?? []), key] } : {}, 'OBSERVING', true),
          effects: [{
            k: 'Emit', taskId: task.id,
            // 写死给模型的话：没执行、别再要、别用文字再征求一遍（实测被拒后会写「确认要发送吗？」然后结束）
            event: { t: 'Observed', callId: event.callId, summary: DENIED_SUMMARY },
          }],
        };
      }
      const call = task.pendingCall;
      if (!call) throw new IllegalTransitionError(task.state, 'ApprovalResolved 无 pendingCall');
      return {
        task: patch({}, 'EXECUTING'),
        // 「始终允许」先记授权再执行；初版两者走同一分支，always 等于 allow（§10 第 66 条）
        effects: event.decision === 'always'
          ? [{ k: 'Grant', taskId: task.id, call }, { k: 'InvokeTool', taskId: task.id, call }]
          : [{ k: 'InvokeTool', taskId: task.id, call }],
      };
    }

    case 'ToolCallStarted':
      return { task: patch({}), effects: [] };

    case 'ToolCallFinished':
      return {
        task: patch({
          usage: addUsage(task.usage, event.meta.metrics.costUSD !== undefined
            ? { costUSD: event.meta.metrics.costUSD } : {}),
          // 污点只会扩散不会自愈：读过一次不可信内容，这个任务后面的每一步都算
          tainted: task.tainted || event.meta.untrusted === true,
          ...(event.meta.ok && task.pendingCall && !(task.toolsSucceeded ?? []).includes(task.pendingCall.toolId)
            ? { toolsSucceeded: [...(task.toolsSucceeded ?? []), task.pendingCall.toolId] }
            : {}),
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
      // 同一轮里模型还给了别的调用：接着执行下一个，不再问模型（它已经决定了）
      const [next, ...rest] = task.queuedCalls ?? [];
      if (next) {
        return {
          task: patch({ guard }, 'PLANNING'),
          effects: [{
            k: 'Emit', taskId: task.id,
            event: {
              t: 'PlanProduced',
              step: { kind: 'tool_call', thought: '同一轮里的下一个调用', call: next, ...(rest.length ? { then: rest } : {}) },
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          }],
        };
      }
      return {
        task: patch({ guard }, 'PLANNING'),
        effects: [{ k: 'CallPlanner', taskId: task.id }],
      };
    }

    case 'RepeatDenied':
      // 模型又要用户已经拒绝过的操作：直接收尾，结果是「按用户的选择没有执行」。
      // 不再给它一轮 —— 实测回喂纠偏后 DeepSeek 仍会原样再要；也不记失败 —— 用户只是做了选择
      return {
        task: patch({ deniedRepeats: event.times }, 'OBSERVING'),
        effects: [settle(task.id, { status: 'SUCCEEDED', answer: '你拒绝了这个操作，它没有执行。' })],
      };

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
