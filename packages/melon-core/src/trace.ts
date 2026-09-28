declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type TraceId = Brand<string, 'TraceId'>;
export type SpanId = Brand<string, 'SpanId'>;

export const asTraceId = (s: string): TraceId => s as TraceId;
export const asSpanId = (s: string): SpanId => s as SpanId;

/**
 * span 的类别。Agent 排障的问题几乎总是「它**为什么**决定调这个工具」，
 * 所以因果树的形状比单个 span 的耗时更重要。
 */
export type SpanKind =
  | 'task'      // 一个任务的整个生命周期
  | 'step'      // ReAct 循环的一步
  | 'context'   // 上下文装配
  | 'model'     // 一次模型调用
  | 'tool'      // 一次工具调用
  | 'recall'    // 技能召回 / 记忆检索
  | 'compact'   // 压缩
  | 'route';    // 模型路由

/**
 * ─── 链路上下文 ───
 *
 * **边界 = 一次触发**，不是一个任务，也不是一个会话：
 * - 用户发一条消息 → 新 trace；子任务继承；**异步派生的 maintenance 任务也继承**
 *   （否则会丢掉「这条记忆是哪次对话写进去的」，而这是隐私排查最常问的）
 * - 定时任务跑 52 次 → 52 个 trace，不是一个横跨一年的 trace
 *
 * **不用 AsyncLocalStorage。** ALS 是隐式状态，与 §2.3「纯函数优先」冲突，
 * 且跨 EffectRunner 边界容易断。改为挂在本来就在流动的对象上
 * （`Task.trace` / `ToolContext.trace` / `PlanInput.trace`）。
 */
export interface TraceContext {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  /**
   * 重放来源。
   * 从事件日志重放历史任务时**必须发新 traceId**，否则重放产生的 span
   * 会污染原始 trace，看起来像当时真跑了两遍。这个字段链回原始 trace。
   */
  readonly replayOf?: TraceId;
}

export interface SpanStatus {
  readonly ok: boolean;
  readonly errorCode?: string;
}

export interface Span {
  readonly ctx: TraceContext;
  /** 属性只接受标量 —— 与 §2.4 一致，span 不该成为敏感数据的副本。 */
  setAttr(key: string, value: string | number | boolean): void;
  end(status?: SpanStatus): void;
}

/**
 * 链路采集端口。默认实现可以只写日志；接 OpenTelemetry 导出到 Jaeger 之类
 * 只需另做一个适配器，内核不变。
 */
export interface Tracer {
  startSpan(name: string, kind: SpanKind, parent: TraceContext): Span;
  /** 派生子上下文而不开 span（用于把上下文透传给子任务）。 */
  child(parent: TraceContext): TraceContext;
  /** 新建一个根上下文。每次触发调一次。 */
  root(replayOf?: TraceId): TraceContext;
}

/**
 * W3C Trace Context 传播格式：`00-{traceId}-{spanId}-{flags}`。
 *
 * 工具调用打到 MCP server 和外部 HTTP API 时按这个格式传下去
 * （`traceparent` 头 / MCP metadata），这样 Agent 的工具调用能和对端自己的日志对上 ——
 * 跨进程排障就靠它。
 *
 * ⚠️ **traceId 绝不能进入提示词。** 它每次都变；一旦出现在 `Message` 里，
 * 上下文的稳定前缀会每轮失效，prompt cache 收益归零
 * （见 kernel-design.md §7.2）。traceId 只进日志与 span。
 */
export const TRACEPARENT_HEADER = 'traceparent';

export interface TracePropagator {
  inject(ctx: TraceContext): Readonly<Record<string, string>>;
  extract(carrier: Readonly<Record<string, string>>): TraceContext | null;
}
