import type { GuardThresholds, GuardWindow, ToolCall } from '@melon-ai/core';
import { DEFAULT_GUARDS } from '@melon-ai/core';

export const callKey = (call: ToolCall): string => `${call.toolId}#${call.argsHash}`;

export function recordCall(w: GuardWindow, call: ToolCall, g: GuardThresholds = DEFAULT_GUARDS): GuardWindow {
  const recentCalls = [...w.recentCalls, callKey(call)].slice(-g.windowSize);
  return { recentCalls, stagnantSteps: w.stagnantSteps };
}

/**
 * 循环检测：同一 `(toolId, argsHash)` 连续出现 `loopRepeats` 次。
 * 注意是**连续**，不是窗口内总次数 —— 交替调用两个工具是正常的推理，不该被拦。
 */
export function detectLoop(w: GuardWindow, g: GuardThresholds = DEFAULT_GUARDS): string | null {
  if (w.recentCalls.length < g.loopRepeats) return null;
  const tail = w.recentCalls.slice(-g.loopRepeats);
  const first = tail[0];
  if (first === undefined) return null;
  return tail.every((k) => k === first) ? first : null;
}

export function bumpStagnant(w: GuardWindow, madeProgress: boolean): GuardWindow {
  return {
    recentCalls: w.recentCalls,
    stagnantSteps: madeProgress ? 0 : w.stagnantSteps + 1,
  };
}

export function detectNoProgress(w: GuardWindow, g: GuardThresholds = DEFAULT_GUARDS): boolean {
  return w.stagnantSteps >= g.stagnantSteps;
}

export const EMPTY_GUARD: GuardWindow = { recentCalls: [], stagnantSteps: 0 };
