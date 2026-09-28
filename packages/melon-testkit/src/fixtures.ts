import type {
  AgentId, CallId, EpisodeId, TaskId, TaskSpec, ToolCall, ToolId, ToolsetSnapshot,
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
