import type { Budget, BudgetDimension, BudgetUsage, Task } from '@melon-ai/core';

export const DEFAULT_BUDGET: Budget = {
  maxSteps: 24,
  maxTokens: 400_000,
  maxCostUSD: 1.0,
  maxWallClockMs: 10 * 60 * 1000,
};

/** 返回第一个耗尽的维度，未耗尽返回 null。多维度同时耗尽时按此顺序报告。 */
export function exhausted(task: Task, now: number): BudgetDimension | null {
  const { budget: b, usage: u } = task;
  if (u.steps >= b.maxSteps) return 'steps';
  if (u.tokens >= b.maxTokens) return 'tokens';
  if (u.costUSD >= b.maxCostUSD) return 'cost';
  if (now - u.startedAt >= b.maxWallClockMs) return 'wallclock';
  return null;
}

export function addUsage(
  u: BudgetUsage,
  delta: { steps?: number; tokens?: number; costUSD?: number },
): BudgetUsage {
  return {
    startedAt: u.startedAt,
    steps: u.steps + (delta.steps ?? 0),
    tokens: u.tokens + (delta.tokens ?? 0),
    costUSD: u.costUSD + (delta.costUSD ?? 0),
  };
}

/**
 * 子任务从父任务分配预算。
 * 不做等分 —— 父任务可能还要继续跑，所以给子任务一个比例上限。
 */
export function deriveChildBudget(parent: Budget, share = 0.5): Budget {
  return {
    maxSteps: Math.max(1, Math.floor(parent.maxSteps * share)),
    maxTokens: Math.max(1, Math.floor(parent.maxTokens * share)),
    maxCostUSD: parent.maxCostUSD * share,
    maxWallClockMs: parent.maxWallClockMs,
  };
}
