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
}

export interface PeakPricing {
  readonly multiplier: number;
  /** IANA 时区，如 `Asia/Shanghai`。时段按这个时区的当地时间判断。 */
  readonly timeZone: string;
  /** 星期几（1 = 周一 … 7 = 周日）的哪些时段，`HH:MM`，左闭右开。 */
  readonly windows: readonly { readonly days: readonly number[]; readonly from: string; readonly to: string }[];
}

/** 这次问模型是为了谁、做什么。规划器填，计量层据此记账；宿主据此分组展示。 */
export interface CallMeta {
  readonly taskId?: TaskId;
  readonly agentId?: string;
  /** 任务类型（`Task.kind`）。 */
  readonly taskKind?: string;
  /** 任务怎么来的（`Task.trigger.type`：manual / schedule …）。 */
  readonly trigger?: string;
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
  /** 费用，`currency` 计。没有价格的模型记 0，并且 `priced = false`。 */
  readonly cost: number;
  readonly currency: Currency;
  readonly priced: boolean;
  /** 耗时（毫秒）；汇总行是总和。 */
  readonly ms: number;
}

export interface UsageQuery {
  readonly from: number;
  readonly to: number;
}
