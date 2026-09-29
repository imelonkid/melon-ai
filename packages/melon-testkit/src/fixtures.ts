import type {
  AgentId, CallId, EpisodeId, Task, TaskId, TaskSpec, ToolCall, ToolId, ToolsetSnapshot,
  TraceContext, Usage,
} from '@melon-ai/core';
import {
  asAgentId, asCallId, asEpisodeId, asSkillId, asSpanId, asTaskId, asToolId, asTraceId,
} from '@melon-ai/core';

export const TASK_ID = asTaskId('task-1');
export const AGENT_ID = asAgentId('agent-1');
export const EPISODE_ID = asEpisodeId('ep-1');

export const TRACE: TraceContext = {
  traceId: asTraceId('trace-1'),
  spanId: asSpanId('span-1'),
};

export const TOOLSET: ToolsetSnapshot = {
  takenAt: 0,
  skills: [{ id: asSkillId('builtin'), version: '0.0.1' }],
};

export function spec(over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    agentId: AGENT_ID,
    kind: 'conversation',
    goal: '测试任务',
    trigger: { type: 'manual' },
    ...over,
  };
}

/**
 * 一个刚创建、还没开始的任务。
 *
 * 给**引擎之外**的测试用（例如工具管线）：它们需要一个 Task 对象，
 * 但不该为此依赖 @melon-ai/engine —— 引擎本身依赖技能包，那样会成环。
 * 引擎自己的测试用真的 createTask。
 */
export function newTask(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID, rootId: TASK_ID, agentId: AGENT_ID, kind: 'conversation', goal: '测试任务',
    state: 'PENDING', trigger: { type: 'manual' },
    budget: { maxSteps: 24, maxTokens: 400_000, maxCostUSD: 1, maxWallClockMs: 600_000 },
    usage: { steps: 0, tokens: 0, costUSD: 0, startedAt: 0 },
    toolset: TOOLSET, episodeId: EPISODE_ID, trace: TRACE, tainted: false,
    guard: { recentCalls: [], stagnantSteps: 0 },
    createdAt: 0, updatedAt: 0, version: 0,
    ...over,
  };
}

let callN = 0;
export function toolCall(toolId = 'mail.send', argsHash = 'h1'): ToolCall {
  return {
    callId: asCallId(`call-${++callN}`),
    toolId: asToolId(toolId),
    args: {},
    argsHash,
  };
}
export function resetCallIds(): void { callN = 0; }

export const usage = (inputTokens = 10, outputTokens = 5, costUSD?: number): Usage =>
  costUSD === undefined ? { inputTokens, outputTokens } : { inputTokens, outputTokens, costUSD };

export type { AgentId, CallId, EpisodeId, TaskId, ToolId };
