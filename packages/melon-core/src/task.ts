import type { AgentId, ArtifactRef, CallId, EpisodeId, TaskId } from './ids.js';
import type { ToolCall, ToolResultMeta, RiskClass } from './tool.js';
import type { ToolsetSnapshot } from './skill.js';
import type { Usage } from './model.js';
import type { PromptRef } from './prompt.js';

export type TaskState =
  | 'PENDING'            // 待执行
  | 'PLANNING'           // 运行中 · Thought
  | 'AWAITING_APPROVAL'  // 待确认
  | 'EXECUTING'          // 运行中 · Act
  | 'OBSERVING'          // 运行中 · Observation
  | 'SUSPENDED'          // 等外部事件 / 等定时 / 等子任务
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export const TERMINAL_STATES: readonly TaskState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export type TaskKind =
  | 'conversation'  // 一次对话轮次
  | 'automation'    // 定时/事件触发的自动化
  | 'maintenance';  // 框架自己的活：压缩、记忆提升

export type TriggerType = 'manual' | 'schedule' | 'event';

export interface Trigger {
  readonly type: TriggerType;
  readonly ref?: string;
}

/** 预算是**多维**的，任一维度耗尽都停。 */
export interface Budget {
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly maxCostUSD: number;
  readonly maxWallClockMs: number;
}

export interface BudgetUsage {
  readonly steps: number;
  readonly tokens: number;
  readonly costUSD: number;
  readonly startedAt: number;
}

export type BudgetDimension = 'steps' | 'tokens' | 'cost' | 'wallclock';

export interface TaskSpec {
  readonly agentId: AgentId;
  readonly kind: TaskKind;
  readonly goal: string;
  readonly trigger: Trigger;
  readonly parentId?: TaskId;
  readonly budget?: Partial<Budget>;
  readonly deadline?: number;
}

export interface Task {
  readonly id: TaskId;
  readonly parentId?: TaskId;
  /** 任务树的根。**同时是 L2 短期记忆的边界** —— 一棵树共享一份工作记忆。 */
  readonly rootId: TaskId;
  readonly agentId: AgentId;
  readonly kind: TaskKind;
  readonly goal: string;
  readonly state: TaskState;
  readonly trigger: Trigger;
  readonly budget: Budget;
  readonly usage: BudgetUsage;
  readonly toolset: ToolsetSnapshot;
  readonly episodeId: EpisodeId;
  /** 当前挂起的审批（state=AWAITING_APPROVAL 时非空）。 */
  readonly pendingCall?: ToolCall;
  /** 正在等待的子任务。 */
  readonly waitingFor?: readonly TaskId[];
  readonly outcome?: Outcome;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deadline?: number;
  /** 乐观并发控制。TaskStore.save 时校验。 */
  readonly version: number;
}

export interface Outcome {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  readonly answer?: string;
  readonly reason?: string;
}

export type ApprovalDecision = 'allow' | 'always' | 'deny';

export interface ApprovalRequest {
  readonly callId: CallId;
  readonly toolId: string;
  readonly risk: RiskClass;
  /** 给用户看的一句话，比如「将周报发送至 产品组（6 人），今天 17:00 定时发出」。 */
  readonly summary: string;
}

// ─────────────────────────────  规划步骤  ─────────────────────────────

export type PlanStep =
  | { readonly kind: 'skill_query'; readonly thought: string; readonly query: string }
  | { readonly kind: 'tool_call'; readonly thought: string; readonly call: ToolCall }
  | { readonly kind: 'spawn'; readonly thought: string; readonly specs: readonly TaskSpec[] }
  | { readonly kind: 'final'; readonly thought: string; readonly answer: string };

// ─────────────────────────────  事件  ─────────────────────────────

/**
 * 事件日志是**唯一真相来源**，Task.state 是物化视图。
 * 所有事件必须可 JSON 序列化 —— 重放能力依赖这一点。
 */
export type TaskEvent =
  | { readonly t: 'Created'; readonly spec: TaskSpec }
  | { readonly t: 'Started' }
  | { readonly t: 'PlanProduced'; readonly step: PlanStep; readonly usage: Usage;
      /** 当时用的提示词版本。缺了它重放结果会和历史对不上。 */
      readonly promptRef?: PromptRef; readonly modelId?: string }
  | { readonly t: 'SkillsInjected'; readonly skillIds: readonly string[] }
  | { readonly t: 'ApprovalRequested'; readonly request: ApprovalRequest }
  | { readonly t: 'ApprovalResolved'; readonly callId: CallId; readonly decision: ApprovalDecision }
  | { readonly t: 'ToolCallStarted'; readonly call: ToolCall }
  | { readonly t: 'ToolCallFinished'; readonly callId: CallId; readonly meta: ToolResultMeta }
  | { readonly t: 'Observed'; readonly callId: CallId; readonly summary: string; readonly artifactRef?: ArtifactRef }
  | { readonly t: 'ChildSpawned'; readonly childId: TaskId }
  | { readonly t: 'ChildSettled'; readonly childId: TaskId; readonly outcome: Outcome }
  | { readonly t: 'Suspended'; readonly until?: number; readonly waitFor?: readonly TaskId[] }
  | { readonly t: 'Resumed' }
  | { readonly t: 'Compacted'; readonly episodeId: EpisodeId }
  | { readonly t: 'BudgetExhausted'; readonly dimension: BudgetDimension }
  | { readonly t: 'NoProgress'; readonly steps: number }
  | { readonly t: 'LoopDetected'; readonly argsHash: string; readonly times: number }
  | { readonly t: 'Cancelled'; readonly reason?: string }
  | { readonly t: 'Settled'; readonly outcome: Outcome };

export type TaskEventType = TaskEvent['t'];

// ─────────────────────────────  副作用  ─────────────────────────────

/**
 * 状态机是**纯函数**：reduce(task, event) → { task, effects }，自己不做任何 I/O。
 * 副作用以描述的形式返回，由 EffectRunner 执行。
 * 换来的是：可单测（不碰模型和数据库）、可重放、崩溃可恢复。
 */
export type Effect =
  | { readonly k: 'CallPlanner'; readonly taskId: TaskId }
  | { readonly k: 'InvokeTool'; readonly taskId: TaskId; readonly call: ToolCall }
  | { readonly k: 'AskUser'; readonly taskId: TaskId; readonly request: ApprovalRequest }
  | { readonly k: 'RecallSkills'; readonly taskId: TaskId; readonly query: string }
  | { readonly k: 'SpawnChildren'; readonly parentId: TaskId; readonly specs: readonly TaskSpec[] }
  | { readonly k: 'NotifyParent'; readonly parentId: TaskId; readonly childId: TaskId; readonly outcome: Outcome }
  | { readonly k: 'ScheduleWake'; readonly taskId: TaskId; readonly at: number }
  | { readonly k: 'Compact'; readonly taskId: TaskId; readonly episodeId: EpisodeId }
  | { readonly k: 'PromoteMemory'; readonly taskId: TaskId; readonly episodeId: EpisodeId }
  | { readonly k: 'Emit'; readonly taskId: TaskId; readonly event: TaskEvent };

export type EffectKind = Effect['k'];

export interface ReduceResult {
  readonly task: Task;
  readonly effects: readonly Effect[];
}
