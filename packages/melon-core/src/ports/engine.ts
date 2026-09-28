import type { Sequenced, TaskId } from '../ids.js';
import type { ApprovalDecision, PlanStep, Task, TaskEvent, TaskSpec } from '../task.js';
import type { ContextBundle } from '../context.js';
import type { ToolSignature } from '../tool.js';
import type { TraceContext } from '../trace.js';

export interface PlanInput {
  readonly task: Task;
  readonly context: ContextBundle;
  readonly availableTools: readonly ToolSignature[];
  /**
   * 本次规划的 span。
   * ⚠️ Planner **不得**把 traceId 写进 `context.messages` ——
   * 会破坏稳定前缀，prompt cache 收益归零。
   */
  readonly trace: TraceContext;
}

/**
 * 可插拔的「大脑」。ReAct 只是其中一种实现；
 * plan-and-execute、单次直答、甚至纯规则驱动都可以实现这个接口。
 *
 * Planner 只决定**下一步做什么**，不碰状态机、不碰存储 —— 机制与策略分离。
 */
export interface Planner {
  readonly kind: string;
  plan(input: PlanInput, signal: AbortSignal): Promise<PlanStep>;
}

/** 意图分类。放在 ReAct 之前做短路：闲聊和纯问答完全不召回 skill、不注入任何 schema。 */
export type Intent = 'chat' | 'qa' | 'task';

export interface IntentClassifier {
  classify(text: string, signal: AbortSignal): Promise<Intent>;
}

/**
 * 宿主应用面向的唯一入口。
 * 框架**不假设任何 UI、任何传输层** —— 它只吐事件，宿主自己决定怎么渲染。
 */
export interface AgentEngine {
  submit(spec: TaskSpec): Promise<Task>;
  get(id: TaskId): Promise<Task | null>;
  cancel(id: TaskId, reason?: string): Promise<void>;
  resolveApproval(id: TaskId, callId: string, decision: ApprovalDecision): Promise<void>;
  /** 订阅任务事件流。从 fromSeq 开始重放，之后转为实时推送。 */
  watch(id: TaskId, fromSeq?: number): AsyncIterable<Sequenced<TaskEvent>>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
