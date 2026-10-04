import type { TaskId } from './ids.js';

/**
 * 计量：模型的价格、每次调用的用量、用量账本。
 *
 * 为什么在引擎：任何宿主（桌面、CLI、服务端）都要知道「花了多少、花在哪、哪家在出错」，
 * 而且任务的费用预算要靠真实花费才生效。宿主只决定怎么展示。
 */

/** 币种。按厂商的计价币种记，汇总时由宿主给汇率折算 —— 引擎不去拉汇率。 */
export type Currency = 'CNY' | 'USD';

/**
 * 模型的价格，单位：每百万 token。
 *
 * 输入分「命中缓存」与「未命中」两档：DeepSeek 等厂商命中缓存的输入便宜一到两个数量级，
 * 不分开算，缓存省下的钱就看不出来。
 */
export interface ModelPrice {
  /** 未命中缓存的输入。 */
  readonly input: number;
  /** 命中缓存的输入。不填按 `input` 算。 */
  readonly cachedInput?: number;
  readonly output: number;
  readonly currency: Currency;
  /**
   * 分时段价（DeepSeek：工作日 9–12、14–18 点为高峰，价格翻倍）。
   * 上面三个价是平时（空闲时段）的价，高峰时段乘以 `multiplier`。
   * 法定节假日按厂商规则也是空闲时段，但引擎不认识节假日 —— 节假日按工作日算，会略微高估。
   */
  readonly peak?: PeakPricing;
  /** 价格的出处（官方文档地址），给人核对用。 */
  readonly source?: string;
  /**
   * 能输入什么（厂商价格页写了「输入模态」的才有）。带 `image` 的按能看图算，比按模型名猜靠谱。
   */
  readonly inputs?: readonly ('text' | 'image' | 'video' | 'file' | 'audio')[];
}

export interface PeakPricing {
  readonly multiplier: number;
  /** IANA 时区，如 `Asia/Shanghai`。时段按这个时区的当地时间判断。 */
  readonly timeZone: string;
  /** 星期几（1 = 周一 … 7 = 周日）的哪些时段，`HH:MM`，左闭右开。 */
  readonly windows: readonly { readonly days: readonly number[]; readonly from: string; readonly to: string }[];
}

/**
 * 套餐：固定月费 + 请求额度（阿里 Coding Plan：每 5 小时 6000 次、每周 45000 次、每月 90000 次）。
 * 额度按同一个厂商（`ModelEntry.egress`）下所有模型的请求数合计 —— 套餐的额度是整个账号共用的。
 * 窗口按滚动时长估算（「每周一零点重置」按 7 天算），与厂商控制台可能略有出入。
 */
export interface PlanPricing {
  readonly name?: string;
  readonly monthlyFee: number;
  readonly currency: Currency;
  readonly quotas: readonly { readonly requests: number; readonly hours: number }[];
}

/** 这次问模型是为了谁、做什么。规划器填，计量层据此记账；宿主据此分组展示。 */
export interface CallMeta {
  readonly taskId?: TaskId;
  readonly agentId?: string;
  /** 任务类型（`Task.kind`）。 */
  readonly taskKind?: string;
  /** 任务怎么来的（`Task.trigger.type`：manual / schedule …）。 */
  readonly trigger?: string;
  /** 触发来源（`Task.trigger.ref`：定时任务是它的 id）。宿主的路由规则据此给单个定时任务绑定模型。不进账本。 */
  readonly triggerRef?: string;
  /** 用途：`RouteIntent`（plan / answer / classify …）。写成 string 是为了不让本文件反过来依赖 model.ts。 */
  readonly purpose: string;
}

/**
 * 用量账本的一条。明细是一次模型调用（`calls = 1`）；
 * 超过保留期的明细按天、按维度汇总成一条（`calls` 为条数，没有任务 id 与尝试序号）。
 */
export interface UsageRecord {
  /** 调用结束的时间；汇总行是当天（UTC）0 点。 */
  readonly at: number;
  readonly calls: number;
  readonly taskId?: TaskId;
  readonly agentId?: string;
  readonly taskKind?: string;
  readonly trigger?: string;
  readonly purpose: string;
  /** 厂商（`ModelEntry.egress`）。 */
  readonly egress: string;
  /** 实际应答的模型 id。 */
  readonly model: string;
  readonly ok: boolean;
  readonly errorCode?: string;
  /** 这一步里第几次尝试（1 起）。失败换下一个模型时递增。 */
  readonly attempt?: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** 费用，`currency` 计。没有价格的模型记 0，并且 `priced = false`；套餐内的调用记 0，`billing = 'plan'`。 */
  readonly cost: number;
  /** `plan`：走的是套餐（月费已付，按次不另计）。不填是按 token 计费。 */
  readonly billing?: 'plan';
  readonly currency: Currency;
  readonly priced: boolean;
  /** 耗时（毫秒）；汇总行是总和。 */
  readonly ms: number;
}

export interface UsageQuery {
  readonly from: number;
  readonly to: number;
}

// ── 价格同步：从厂商的官方价格文档拉取 ──

/**
 * 一家厂商的价格来源（官方文档）。厂商实现在 `@melon-ai/plugins`，每家一个子路径；引擎只管定时同步、校验、存档。
 * `vendor` 与 `ModelEntry.egress` 一致 —— 同步来的价格按它对到模型上。
 */
export interface PriceSource {
  readonly vendor: string;
  readonly label?: string;
  /** 官方价格文档的地址，给人核对用。 */
  readonly url: string;
  fetch(signal: AbortSignal): Promise<PriceSheet>;
}

export interface PriceSheet {
  /** 模型 id → 价格。 */
  readonly prices: Readonly<Record<string, ModelPrice>>;
  /** 给人看的说明，如「按输入长度分档的，取最低一档」。 */
  readonly notes?: readonly string[];
}

/** 一个模型的价格变了。 */
export interface PriceChange {
  readonly model: string;
  readonly from?: ModelPrice;
  readonly to: ModelPrice;
  /** 输入、输出里变化最大的倍数（≥ 1）。 */
  readonly ratio: number;
}

/**
 * 一次同步的结果（每家一条最新的）。失败时 `prices` 保持上一次成功的 —— 页面改版了也不会把价格清空。
 */
export interface PriceSync {
  readonly vendor: string;
  readonly url: string;
  readonly at: number;
  readonly ok: boolean;
  readonly error?: string;
  /** 生效中的价格（模型 id → 价格）。 */
  readonly prices: Readonly<Record<string, ModelPrice>>;
  /** 这次生效的变化（新模型、小幅调价）。 */
  readonly changed: readonly PriceChange[];
  /** 变化太大、等用户确认的（防止表格解析错位把价格读成别的列）。确认前用旧价。 */
  readonly pending: readonly PriceChange[];
  readonly lastSuccessAt?: number;
  readonly notes?: readonly string[];
}

/**
 * 花钱前的检查（宿主给）：每次要花钱的调用（问模型、按次计费的工具）之前问一次。返回 null 放行；返回原因就不调 ——
 * 模型换下一家（都不行就以这个原因结束），工具这次不执行、把原因交给模型。
 * 引擎不管额度怎么算（按天、滚动几小时、按人）：那是宿主的策略，宿主可以用 `agent.usage` 的账本自己算。
 */
export interface SpendCheck {
  readonly kind: 'model' | 'tool';
  /** 哪一家（模型的 egress、工具 billing 的 vendor）。 */
  readonly vendor: string;
  readonly meta?: CallMeta;
}
export interface SpendDenial {
  /** 给用户看的原因（会出现在任务的失败原因里）。 */
  readonly reason: string;
  /** 什么时候恢复（毫秒时间戳），没有就不说。 */
  readonly resumeAt?: number;
}
export type SpendGuard = (check: SpendCheck) => Promise<SpendDenial | null> | SpendDenial | null;
