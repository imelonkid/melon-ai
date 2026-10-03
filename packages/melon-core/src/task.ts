import type { AgentId, ArtifactRef, CallId, EpisodeId, SkillId, TaskId } from './ids.js';
import type { ToolCall, ToolResultMeta, RiskClass } from './tool.js';
import type { Usage } from './model.js';
import type { PromptRef } from './prompt.js';
import type { SpanId, TraceContext } from './trace.js';

/**
 * 任务启动时对可用工具集做的快照。
 * **必须钉住版本**：否则 MCP server 中途更新会让同一个 toolId 含义改变，事件日志就不可重放了。
 */
export interface ToolsetSnapshot {
  readonly takenAt: number;
  readonly skills: readonly { readonly id: SkillId; readonly version: string }[];
  /**
   * 任务开始时每个工具定义的指纹（说明、参数、风险……）。执行时对不上的不认 ——
   * 扩展来源（MCP server）可能在任务进行中把同名工具换成另一个意思。快照之后才出现的工具不在这里，照常解析。
   * 旧任务没有这一项：按当前注册的解析。
   */
  readonly tools?: Readonly<Record<string, string>>;
}

export type TaskState =
  | 'PENDING'            // 待执行
  | 'PLANNING'           // 运行中 · Thought
  /**
   * 运行中 · 准入判定。
   *
   * 这个状态是实现 reducer 时发现必须加的：reducer 是纯函数，**拿不到准入结果**
   * （准入要查 grant、查配额，是 I/O）。所以准入决策必须以事件形式回到状态机。
   *
   * 它也让崩溃恢复更省：崩在准入阶段，重启后只需重跑准入（幂等、便宜），
   * 而不必重跑模型（贵）。
   */
  | 'ADMITTING'
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

/**
 * 守卫窗口。循环检测与无进展检测是 ReAct 在生产中最常见的两种失败模式，
 * 必须在内核层拦，不能指望模型自觉。
 */
export interface GuardWindow {
  /** 最近若干次工具调用的 `${toolId}#${argsHash}`，用于循环检测。 */
  readonly recentCalls: readonly string[];
  /** 连续多少步没有新事实进入 L2。 */
  readonly stagnantSteps: number;
  /**
   * 上一次观察结果的指纹。
   *
   * 「连续相同参数」这个判据太弱 —— 模型只要微调一下参数就绕过去了，
   * 实测中它换了 4 种 query 调同一个工具 7 次，拿到的永远是同一句话。
   * **一字不差的重复观察就是没有进展**，跟参数是否相同无关。
   */
  readonly lastObservation?: string;
}

export interface GuardThresholds {
  /** 同一调用连续出现多少次算循环。 */
  readonly loopRepeats: number;
  /** 连续多少步无进展就干预。 */
  readonly stagnantSteps: number;
  /** recentCalls 保留多长。 */
  readonly windowSize: number;
}

export const DEFAULT_GUARDS: GuardThresholds = {
  loopRepeats: 3,
  stagnantSteps: 4,
  windowSize: 8,
};

/**
 * 用户随这一轮给的文件（附件）。原文件的文字已经抽出来存成 artifact；任务能读它（不受「只能读本任务的 artifact」限制）。
 * `fresh`：这一轮新给的 —— 上下文里带开头；沿用之前轮次的只列出来、给句柄。
 */
export interface Attachment {
  readonly name: string;
  readonly size: number;
  /** 给人看的说明：「PDF，12 页」「Excel，3 张表」。 */
  readonly note: string;
  readonly textRef: ArtifactRef;
  readonly chars: number;
  readonly fresh: boolean;
  /** 开头一段文字（新给的才有）：直接进上下文，不用先读一次句柄。 */
  readonly head?: string;
  /**
   * 图片附件：`textRef` 存的是图片本身（不是文字，`chars` 为 0），这里写类型。
   * 进上下文时作为图片发给能看图的模型；不当文字读。
   */
  readonly image?: { readonly mime: string };
}

export interface TaskSpec {
  readonly agentId: AgentId;
  readonly kind: TaskKind;
  readonly goal: string;
  readonly trigger: Trigger;
  readonly attachments?: readonly Attachment[];
  /** 绑定的画布（对话里的那块）。Agent 用 `canvas.read` / `canvas.update` 读改它。 */
  readonly canvas?: { readonly id: string; readonly kind: string };
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
  readonly attachments?: readonly Attachment[];
  /** 绑定的画布（对话里的那块）。Agent 用 `canvas.read` / `canvas.update` 读改它。 */
  readonly canvas?: { readonly id: string; readonly kind: string };
  readonly state: TaskState;
  readonly trigger: Trigger;
  readonly budget: Budget;
  readonly usage: BudgetUsage;
  readonly toolset: ToolsetSnapshot;
  readonly episodeId: EpisodeId;
  /**
   * 链路上下文。traceId 在任务内不变，**所以不要往每条事件上复制** ——
   * 事件通过 taskId 关联即可。只有代表「一次工作」的事件带 spanId。
   */
  readonly trace: TraceContext;
  /**
   * 本 episode 消费过不可信的扩展工具输出。
   * 一旦置位便不再清除（污点只会扩散，不会自愈），直到 episode 关闭。
   * 由 reducer 在 `ToolCallFinished.meta.untrusted` 时置位。见 policy.ts `TAINT_FORCES_ASK`。
   */
  readonly tainted: boolean;
  /** 守卫窗口。纯 reducer 只能看到 task，循环与无进展检测所需的历史必须挂在这里。 */
  readonly guard: GuardWindow;
  /**
   * 本任务里**执行成功过**的工具（去重，按首次成功的顺序）。
   *
   * 规划器据此判断「说做了的事到底做没做」：答复里写「已发送」，这里却没有任何
   * 发送类工具，那就是模型在编。由 reducer 在 `ToolCallFinished.meta.ok` 时追加。
   * 旧数据没有这个字段，按空处理。
   */
  readonly toolsSucceeded?: readonly string[];
  /** 本任务里**模型发起过调用**的工具（去重）。动作守卫据此判断「该做的动作有没有尝试过」。 */
  readonly toolsCalled?: readonly string[];
  /**
   * 用户拒绝过的工具（toolId）。同一个任务里**不再为这类操作去问用户** ——
   * 模型被拒后常常再要一次：原样再要（实测 DeepSeek 连要 5 次），或改几个字再要（正文换了措辞）。
   * 对用户来说拒绝的是「这个任务里别发这封信」，措辞变了不是新请求，所以按工具记，不按参数记。
   */
  readonly denied?: readonly string[];
  /** 模型重复请求被拒操作的次数。 */
  readonly deniedRepeats?: number;
  /** 当前挂起的审批（state=AWAITING_APPROVAL 时非空）。 */
  readonly pendingCall?: ToolCall;
  /** 同一轮里还没轮到的调用（`PlanStep.then`）。上一个有了结果就接着执行下一个，不再问模型。 */
  readonly queuedCalls?: readonly ToolCall[];
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
  /**
   * 回答写到一半被取消时，用户已经看到的那一截。没写完、没过核对 —— 不是回答，宿主照原样显示并标明「没写完」。
   */
  readonly partial?: string;
}

export type ApprovalDecision = 'allow' | 'always' | 'deny';

export interface ApprovalRequest {
  readonly callId: CallId;
  readonly toolId: string;
  readonly risk: RiskClass;
  /** 给用户看的一句话，比如「将周报发送至 产品组（6 人），今天 17:00 定时发出」。 */
  readonly summary: string;
  /** 这次能不能「始终允许」。花钱、不可撤销的操作每次都要问（`GRANTABLE_RISKS`），宿主据此决定显不显示这个按钮。 */
  readonly canAlways?: boolean;
}

// ─────────────────────────────  规划步骤  ─────────────────────────────

/**
 * 这一步是怎么得出的：用的哪版提示词、哪个模型。运行时把它写进 `PlanProduced`，
 * 重放历史时才知道当时的条件（§2.3）。没问模型就得出的步骤（守卫直接拒绝）没有 `modelId`。
 */
export interface PlanVia {
  readonly promptRef?: PromptRef;
  readonly modelId?: string;
  /** 这一步的上下文发给了哪家（`ModelEntry.egress`）。运行时据此记「数据去向」审计。 */
  readonly egress?: string;
  /**
   * 模型这一步的思考过程（支持的模型才有：DeepSeek 推理模式的 `reasoning_content`、Claude 的 thinking 块）。
   * 只为给人看、事后排查：**不回灌进以后的上下文**（又贵又会让模型把推测当成事实），截断到 `MAX_REASONING_CHARS`。
   */
  readonly reasoning?: string;
  /**
   * 这一步问模型的真实用量（一步里问了几次就加几次：守卫纠正、参数退回、换模型）。
   * 运行时把它记到任务上，费用预算据此生效；不填时退回到按上下文估的输入 token。
   */
  readonly usage?: Usage;
}

/** 落库的思考过程上限。几十 KB 的推理进事件日志不划算，看的人也只看开头。 */
export const MAX_REASONING_CHARS = 8_000;

export type PlanStep = (
  | { readonly kind: 'skill_query'; readonly thought: string; readonly query: string }
  /** `then`：模型同一轮给的其余调用，排队依次执行（每个照样走准入与守卫）。 */
  | { readonly kind: 'tool_call'; readonly thought: string; readonly call: ToolCall; readonly then?: readonly ToolCall[] }
  | { readonly kind: 'spawn'; readonly thought: string; readonly specs: readonly TaskSpec[] }
  | { readonly kind: 'final'; readonly thought: string; readonly answer: string }
  /**
   * 规划器判定这件事**没有做成**，任务以 FAILED 收尾。
   *
   * 和 `final` 分开：「没有合适的工具」「模型没执行却说做了」这类结果如果走 `final`，
   * 任务会记成成功，界面上就是「已完成」—— 用户会以为邮件已经发出去了。
   */
  | { readonly kind: 'abort'; readonly thought: string; readonly reason: string }
) & { readonly via?: PlanVia };

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
      readonly promptRef?: PromptRef; readonly modelId?: string;
      readonly spanId?: SpanId }
  | { readonly t: 'SkillsInjected'; readonly skillIds: readonly string[] }
  /**
   * 准入判定结果。`basis` 是事后举证的关键 ——
   * §4.5 指出「授权决策没记依据」是 EventLog 的窟窿之一，这里补上。
   */
  | { readonly t: 'AdmissionResolved'; readonly callId: CallId;
      readonly decision: 'allow' | 'ask' | 'deny'; readonly reason: string;
      /** 判定针对的风险等级。reducer 拿不到工具描述，构造 ApprovalRequest 需要它。 */
      readonly risk: RiskClass;
      readonly basis?: Readonly<Record<string, string | number | boolean>> }
  | { readonly t: 'ApprovalRequested'; readonly request: ApprovalRequest }
  | { readonly t: 'ApprovalResolved'; readonly callId: CallId; readonly decision: ApprovalDecision }
  | { readonly t: 'ToolCallStarted'; readonly call: ToolCall; readonly spanId?: SpanId }
  | { readonly t: 'ToolCallFinished'; readonly callId: CallId; readonly meta: ToolResultMeta; readonly spanId?: SpanId }
  /** callId 可缺省：守卫注入的纠偏 observation 没有对应的真实工具调用。 */
  | { readonly t: 'Observed'; readonly callId?: CallId; readonly summary: string; readonly artifactRef?: ArtifactRef }
  | { readonly t: 'ChildSpawned'; readonly childId: TaskId }
  | { readonly t: 'ChildSettled'; readonly childId: TaskId; readonly outcome: Outcome }
  | { readonly t: 'Suspended'; readonly until?: number; readonly waitFor?: readonly TaskId[] }
  | { readonly t: 'Resumed' }
  | { readonly t: 'Compacted'; readonly episodeId: EpisodeId }
  | { readonly t: 'BudgetExhausted'; readonly dimension: BudgetDimension }
  | { readonly t: 'NoProgress'; readonly steps: number }
  | { readonly t: 'LoopDetected'; readonly argsHash: string; readonly times: number }
  /** 模型又请求了一个用户已经拒绝过的操作。不问用户、不执行，任务以「没有执行」收尾。 */
  | { readonly t: 'RepeatDenied'; readonly toolId: string; readonly times: number }
  | { readonly t: 'Cancelled'; readonly reason?: string; readonly partial?: string }
  | { readonly t: 'Settled'; readonly outcome: Outcome };

export type TaskEventType = TaskEvent['t'];

// ─────────────────────────────  副作用  ─────────────────────────────

/**
 * 状态机是**纯函数**：reduce(task, event) → { task, effects }，自己不做任何 I/O。
 * 副作用以描述的形式返回，由 EffectRunner 执行。
 * 换来的是：可单测（不碰模型和数据库）、可重放、崩溃可恢复。
 */
/**
 * 副作用。
 *
 * **所有 Effect 必须幂等。** 崩溃恢复的规则是「重新 reduce 最后一条事件、
 * 重跑它产生的 effects」—— 因为 reducer 是纯函数，这是最省的恢复方式，
 * 但它要求重跑不会造成重复的外部后果。
 */
export type Effect =
  | { readonly k: 'CallPlanner'; readonly taskId: TaskId }
  | { readonly k: 'Admit'; readonly taskId: TaskId; readonly call: ToolCall }
  | { readonly k: 'InvokeTool'; readonly taskId: TaskId; readonly call: ToolCall }
  /** 用户点了「始终允许」：记下授权，以后同一工具、同一范围不再问。 */
  | { readonly k: 'Grant'; readonly taskId: TaskId; readonly call: ToolCall }
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
