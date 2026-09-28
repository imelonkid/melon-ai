import type { JSONSchema } from './tool.js';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly costUSD?: number;
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly name?: string;
  /**
   * 前缀缓存断点提示。装配器在稳定段末尾打这个标记，
   * 适配器把它翻译成各家的缓存机制（不支持就忽略）。
   */
  readonly cacheBoundary?: boolean;
}

/**
 * 给模型看的工具定义。
 *
 * 与 `ToolSignature`（常驻上下文的廉价签名）不同，这里带**全量 schema** ——
 * 供应商原生的 tool use 需要完整 schema 才能约束参数。
 *
 * 这不与 §7.5 的两级 schema 冲突：两级优化解决的是「工具太多」，
 * 而经过技能召回后进入 `availableTools` 的只有 2~3 个，全量发送是划算的。
 */
export interface ModelTool {
  /** 工具 id。供应商侧的 tool name。 */
  readonly name: string;
  readonly description: string;
  readonly input: JSONSchema;
}

/** 模型选择的工具调用。 */
export interface ModelToolCall {
  /** 供应商给的调用 id，回传 tool_result 时要用。 */
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface GenerateRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ModelTool[];
  /** 要求模型必须选一个工具。部分模型（Opus 5.5 / Fable 5.1）不支持强制，适配器需降级。 */
  readonly toolChoice?: 'auto' | 'required';
  /** 要求模型按此 schema 输出。不支持的适配器需降级为提示词约束。 */
  readonly responseSchema?: JSONSchema;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface GenerateResult {
  readonly text: string;
  /** 模型选择的工具调用。原生 tool use 比解析文本可靠得多。 */
  readonly toolCalls?: readonly ModelToolCall[];
  readonly usage: Usage;
  readonly modelId: string;
  /** `filtered` 表示被安全分类器拒绝（Anthropic 的 `stop_reason: refusal`）。 */
  readonly stopReason: 'stop' | 'length' | 'tool' | 'filtered' | 'error';
}

export interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly tools: boolean;
  readonly jsonSchema: boolean;
  /** 支持前缀缓存。装配器据此决定值不值得为缓存做排序优化。 */
  readonly promptCache: boolean;
}

export interface ChatModel {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream?(req: GenerateRequest): AsyncIterable<{ delta: string }>;
}

/** 计 token。独立成端口是因为不同模型分词不同，而预算计算必须准。 */
export interface Tokenizer {
  count(text: string): number;
  countMessages(msgs: readonly Message[]): number;
}

/** 路由用途。对应产品里「质量优先 / 均衡 / 成本优先」三档策略的输入。 */
export type RouteIntent =
  | 'plan'        // ReAct 主循环推理，质量最敏感
  | 'classify'    // 意图分类，便宜优先
  | 'compact'     // 压缩摘要，中等
  | 'extract'     // 记忆抽取，便宜优先
  | 'answer';     // 最终作答

/**
 * 路由决策。返回**候选序列**而不是单个模型：
 * router 只负责「选」，真正的重试与熔断由 melon-tools 那套统一机制执行 ——
 * 不要在系统里养两套重试逻辑。理由见 docs/architecture.md §4.6。
 */
export interface RouteDecision {
  readonly primary: ChatModel;
  readonly fallbacks: readonly ChatModel[];
  readonly reason: string;
  /**
   * 数据将被发往的供应商标识。**必须记审计** ——
   * 产品侧已把「数据不出境」作为模型选择的卖点，
   * 「哪份数据被哪个供应商看到过」是硬合规要求。
   */
  readonly egress: readonly string[];
}

export interface ModelRouter {
  select(intent: RouteIntent, signal?: AbortSignal): Promise<RouteDecision>;
  tokenizerFor(model: ChatModel): Tokenizer;
}

export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}
