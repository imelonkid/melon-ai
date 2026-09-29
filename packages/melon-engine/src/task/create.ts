import type {
  AgentId, EpisodeId, GuardWindow, Task, TaskId, TaskSpec, ToolsetSnapshot, TraceContext,
} from '@melon-ai/core';
import { DEFAULT_BUDGET } from './budget.js';
import { EMPTY_GUARD } from './guards.js';

export interface CreateTaskInput {
  readonly id: TaskId;
  readonly spec: TaskSpec;
  readonly rootId: TaskId;
  readonly episodeId: EpisodeId;
  readonly toolset: ToolsetSnapshot;
  readonly trace: TraceContext;
  readonly now: number;
  readonly guard?: GuardWindow;
}

export function createTask(input: CreateTaskInput): Task {
  const { id, spec, rootId, episodeId, toolset, trace, now } = input;
  const base = {
    id,
    rootId,
    agentId: spec.agentId as AgentId,
    kind: spec.kind,
    goal: spec.goal,
    state: 'PENDING' as const,
    trigger: spec.trigger,
    budget: { ...DEFAULT_BUDGET, ...spec.budget },
    usage: { steps: 0, tokens: 0, costUSD: 0, startedAt: now },
    toolset,
    episodeId,
    trace,
    tainted: false,
    guard: input.guard ?? EMPTY_GUARD,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
  // exactOptionalPropertyTypes 下不能给可选字段赋 undefined
  return {
    ...base,
    ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
    ...(spec.deadline !== undefined ? { deadline: spec.deadline } : {}),
  };
}
