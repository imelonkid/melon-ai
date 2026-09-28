import type { JSONSchema, ToolSignature } from './tool.js';

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

export interface GenerateRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSignature[];
  /** 要求模型按此 schema 输出。不支持的适配器需降级为提示词约束。 */
  readonly responseSchema?: JSONSchema;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface GenerateResult {
  readonly text: string;
  readonly usage: Usage;
  readonly modelId: string;
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

export interface ModelRouter {
  select(intent: RouteIntent): Promise<ChatModel>;
  tokenizerFor(model: ChatModel): Tokenizer;
}

export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}
