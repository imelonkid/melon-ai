import type { ArtifactRef } from './ids.js';
import type { JSONSchema, RiskClass } from './tool.js';
import type { CallMeta, Currency, ModelPrice, PlanPricing } from './usage.js';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  /** 折成美元的费用：任务的费用预算按它算。 */
  readonly costUSD?: number;
  /** 按厂商币种的费用。没有价格的模型不填。 */
  readonly cost?: { readonly amount: number; readonly currency: Currency };
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
  /**
   * 这条消息是谁说的。observation 这类工具结果也以 user 角色回灌（模型把它当「刚发生的事实」），
   * 但它**不是用户说的** —— 判断「收件人是不是用户给的」时必须分开（见 `ToolDescriptor.userSupplied`）。
   * 不填按用户说的算。适配器不发这个字段。
   * `memory` 是之前对话里用户让记住的事 —— 来自用户、写入时过了审查，参数来源核对时算用户说过。
   */
  readonly from?: 'user' | 'host' | 'tool' | 'memory';
  /**
   * 这条在上下文里属于哪一段 —— 超出预算时按段压缩（见 agent 的 `fitContext`）：
   * - `history`：之前的对话（宿主给的问答），旧的先摘要
   * - `step`：本任务的步骤（调用了什么、模型的想法）
   * - `result`：本任务的工具结果，旧的先截短
   * 不标的（宿主的说明、任务目标、当前时间、记忆）不压缩。适配器不发这个字段。
   */
  readonly part?: 'history' | 'step' | 'result';
  /**
   * 随这条消息的图片（用户给的截图、照片）。装配器只写句柄；发给模型前由 agent 读出内容（`data`，base64），
   * 适配器转成各家的格式。模型看不了图（`capabilities.vision` 不为 true）时路由不会选它。
   */
  readonly images?: readonly MessageImage[];
}

export interface MessageImage {
  readonly ref: ArtifactRef;
  readonly mime: string;
  /** base64。发给模型前才填。 */
  readonly data?: string;
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
  /**
   * 以下两项**不发给模型**，给规划器做规则判定用（动作守卫）：
   * 适配器只取 name / description / input。
   */
  readonly risk?: RiskClass;
  readonly triggers?: readonly string[];
  readonly userSupplied?: readonly string[];
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
  /**
   * 流式输出：支持的适配器边收边回调，参数是**到目前为止的全文**（不是增量）——
   * 回调方不用自己拼，中途换了一路输出（重试、回退到别的模型）也只是整段替换。
   * 不支持流式的适配器忽略它，照常一次性返回；无论哪种，`generate()` 的返回值都是完整结果。
   */
  readonly onText?: (textSoFar: string) => void;
  /** 思考过程的流式回调，同样给到目前为止的全文。模型不输出思考就不会被调用。 */
  readonly onReasoning?: (reasoningSoFar: string) => void;
  /**
   * 这次调用为谁、做什么：计量层据此记账。适配器不看它。
   * 不填的调用（连接测试等）不进账本。
   */
  readonly meta?: CallMeta;
  /**
   * 换模型重试时、开始下一次尝试之前回调：上一个模型流式吐出的半截内容作废。
   * 回调方据此把已显示的草稿收起来。
   */
  readonly onRetry?: () => void;
}

export interface GenerateResult {
  readonly text: string;
  /** 模型选择的工具调用。原生 tool use 比解析文本可靠得多。 */
  readonly toolCalls?: readonly ModelToolCall[];
  /** 思考过程（支持的模型才有）。不是回答，也不该回灌进上下文。 */
  readonly reasoning?: string;
  readonly usage: Usage;
  /** 实际应答的厂商（失败换了模型时不是首选那家）。由路由层填，适配器不填。 */
  readonly egress?: string;
  /** 这次结果之前失败过几次（换过几个模型）。由路由层填。 */
  readonly failedAttempts?: readonly { readonly egress: string; readonly model: string; readonly errorCode: string }[];
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
  /** 能看图（消息里可以带图片）。不填按看不了算。 */
  readonly vision?: boolean;
}

export interface ChatModel {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream?(req: GenerateRequest): AsyncIterable<{ delta: string }>;
  /**
   * 这个账号在这家能用哪些模型（OpenAI 兼容的 `/models`、Anthropic 的 `/v1/models`）。
   * 宿主用它做「新发现的模型」。不支持的适配器不实现。
   */
  listModels?(signal?: AbortSignal): Promise<readonly string[]>;
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
 * router 只负责「选」，真正的重试与熔断由 skills 的工具管线统一执行 ——
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

/**
 * 一个可用的模型及其路由属性。
 *
 * 模型适配器的工厂函数（`deepseek()`、`claude()`……）返回它，路由按它排序。
 * 放在 core 是因为它是适配器与路由之间的契约 —— 两边互不认识。
 */
export interface ModelEntry {
  readonly model: ChatModel;
  /** 相对质量分，越高越强。用于 quality 策略排序。 */
  readonly quality: number;
  /** 每百万输入 token 的美元价，用于 cost 策略排序。有 `price` 时以它为准折算。 */
  readonly costUSD: number;
  /** 价格（输入 / 缓存 / 输出，按厂商币种）。不填 = 不知道价格：照常记用量，费用记为「未计价」，不瞎估。 */
  readonly price?: ModelPrice;
  /** 档次。不填 = 未定档：不参与自动路由，只能被固定使用。 */
  readonly tier?: ModelTier;
  /**
   * 价格从哪来。`manual`（用户手填）优先于同步来的官方价格，同步不覆盖；
   * `builtin`（引擎内置表）会被同步来的价格替换。不填按 builtin。
   */
  readonly priceSource?: 'manual' | 'builtin' | 'synced';
  /** 套餐计费（固定月费 + 额度，如阿里 Coding Plan）。有它时按次不另计费，路由优先用、额度快满时让位。 */
  readonly plan?: PlanPricing;
  /** 数据发往的供应商标识。进审计，支撑「数据不出境」这类合规要求。 */
  readonly egress: string;
  readonly enabled?: boolean;
  /** 给人看的名字，如「DeepSeek」。 */
  readonly label?: string;
}

/**
 * 模型的档次：基础（分类、摘要这类辅助调用够用）/ 标准（日常对话与任务）/ 强（难题）。
 * 自动路由按「这类任务最低要什么档」筛模型。没定档的模型不参与自动路由（可以被固定使用）。
 */
export type ModelTier = 'basic' | 'standard' | 'strong';
export const TIER_RANK: Readonly<Record<ModelTier, number>> = { basic: 1, standard: 2, strong: 3 };

/** 这次要模型做什么：路由据此筛选（要工具的只给支持工具的模型）、按任务类别套规则。 */
export interface RouteContext {
  readonly needsTools?: boolean;
  /** 这一轮带图片：只在能看图的模型里选。 */
  readonly needsVision?: boolean;
  readonly meta?: CallMeta;
}

export interface ModelRouter {
  select(intent: RouteIntent, signal?: AbortSignal, ctx?: RouteContext): Promise<RouteDecision>;
  tokenizerFor(model: ChatModel): Tokenizer;
}

export interface Embedder {
  readonly id: string;
  readonly dims: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

// ── 模型目录：跟随厂商最新可用的模型 ──

/**
 * 一家厂商。模型目录用它把这家最新可用的模型接进来：
 * 拉这个账号能用的模型（`/models`），和官方价格文档里有价格的取交集，自动定档，加入路由。
 *
 * 宿主只给「怎么造一个模型条目」和用户的改动；列表、定档、刷新都是引擎的。
 */
export interface ModelProvider {
  /** 厂商标识，与 `ModelEntry.egress` 一致。 */
  readonly vendor: string;
  readonly label?: string;
  /** 造一个模型条目（带引擎内置的档次、价格）。不给 id 时用这家的默认模型。认不出的 id 可以抛错。 */
  make(modelId?: string): ModelEntry;
  /** 用户的改动，按模型 id。没有改动的模型完全跟随官方。 */
  readonly overrides?: Readonly<Record<string, ModelOverride>>;
  /**
   * 连接配置的指纹（key、地址变了它就变）。变了立即重新拉模型列表。
   * 宿主给摘要即可，别给明文 key。
   */
  readonly fingerprint?: string;
}

export interface ModelOverride {
  /** `false`：用户关掉了这个模型。 */
  readonly enabled?: boolean;
  /** 用户定的档次；`null` 是明确不定档（不参与自动路由）。 */
  readonly tier?: ModelTier | null;
  /** 用户手填的价格，优先于同步来的。 */
  readonly price?: ModelPrice;
  /** 用户手动加的：没有官方价格、不在目录里也要用。 */
  readonly added?: boolean;
}

/** 一家厂商上次拉到的模型列表（存档：离线启动时用它）。 */
export interface ModelListing {
  readonly vendor: string;
  readonly at: number;
  readonly ok: boolean;
  readonly error?: string;
  /** 上次成功拉到的模型 id。从没成功过时没有。 */
  readonly ids?: readonly string[];
  readonly lastSuccessAt?: number;
  readonly fingerprint?: string;
}

/** 目录里的一个模型：在不在官方列表、档次怎么定的、价格从哪来、参不参与路由。 */
export interface CatalogModel {
  readonly id: string;
  /** 这个账号现在能不能用（在 `/models` 里）。没拉成功过时为 null。 */
  readonly available: boolean | null;
  /** 有官方价格或内置档次 —— 跟随官方时自动加入的就是这些。 */
  readonly official: boolean;
  readonly tier?: ModelTier;
  /** 档次怎么来的：用户定的 / 引擎内置 / 按这家的价格高低自动定 / 没定。 */
  readonly tierBy: 'user' | 'builtin' | 'price' | 'none';
  readonly price?: ModelPrice;
  readonly priceSource?: 'manual' | 'builtin' | 'synced';
  readonly tools: boolean;
  readonly added: boolean;
  /** 参与路由：没被关、没下架。 */
  readonly active: boolean;
  /** 不参与的原因：`off`（用户关了）、`gone`（官方列表里已没有）。 */
  readonly inactive?: 'off' | 'gone';
}

export interface VendorCatalog {
  readonly vendor: string;
  readonly label?: string;
  readonly listing?: ModelListing;
  /** 目录里的模型（官方的 + 用户加的），按档次从强到弱。 */
  readonly models: readonly CatalogModel[];
  /** 这个账号能用、但没有官方价格的其余模型：给「添加模型」的下拉框。 */
  readonly others: readonly string[];
}
