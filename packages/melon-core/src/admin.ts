/**
 * 后台（运营管理）的契约：额度策略、花费流水、站点设置。
 *
 * 多用户的宿主（服务端）给每个用户一个引擎实例，「谁有多少额度、今天花了多少」要跨实例看 ——
 * 所以这份数据不在单个实例的存储里，而是宿主全局一份（`AdminStore`），由 `@melon-ai/admin` 读写。
 * 「用户」是宿主的概念：引擎只认一个不透明的 `principal`（宿主的用户 id）。
 */
import type { Currency } from './usage.js';

/** 额度怎么定：走通用策略、单独设、不限。 */
export type QuotaMode = 'default' | 'custom' | 'unlimited';

export interface QuotaPolicy {
  readonly mode: QuotaMode;
  /** `custom` 时各时间窗的金额（按后台的币种）；缺的时间窗按通用策略。 */
  readonly amounts?: Readonly<Record<string, number>>;
}

/**
 * 一个时间窗：
 * - `day`：自然日，按 `tzOffsetMinutes` 的当地 0 点清零（北京时间是 480）；
 * - `rolling`：最近 `hours` 小时（滚动）。
 */
export type QuotaWindow =
  | { readonly id: string; readonly label: string; readonly kind: 'day'; readonly tzOffsetMinutes: number }
  | { readonly id: string; readonly label: string; readonly kind: 'rolling'; readonly hours: number };

/** 一笔花费。宿主的每次调用都记（`counted` 标出算不算额度），概览里的调用次数、失败数也从这里来。 */
export interface SpendEntry {
  readonly principal: string;
  readonly at: number;
  /** 折成后台币种后的金额；没价格的是 0。 */
  readonly amount: number;
  readonly currency: Currency;
  /** 算不算额度（宿主决定：比如只有用服务端提供的 key 才算）。 */
  readonly counted: boolean;
  readonly kind: 'model' | 'tool';
  /** 厂商（模型的 egress、工具的计费厂商）。 */
  readonly vendor: string;
  readonly model: string;
  readonly ok: boolean;
}

export interface SpendQuery {
  readonly from: number;
  readonly to?: number;
  readonly principal?: string;
  /** 只要算额度的。 */
  readonly countedOnly?: boolean;
}

/** 后台的存储端口。实现：`@melon-ai/store/sqlite` 的 `openSqliteAdminStore`、testkit 的内存版。 */
export interface AdminStore {
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
  getPolicy(principal: string): Promise<QuotaPolicy | null>;
  /** `null` 删掉（回到通用策略）。 */
  setPolicy(principal: string, policy: QuotaPolicy | null): Promise<void>;
  listPolicies(): Promise<Readonly<Record<string, QuotaPolicy>>>;
  recordSpend(entry: SpendEntry): Promise<void>;
  /** 算额度的花费合计。 */
  sumCounted(principal: string, from: number, to?: number): Promise<number>;
  listSpend(q: SpendQuery): Promise<readonly SpendEntry[]>;
  /** 删掉 `before` 之前的流水。 */
  purgeSpend(before: number): Promise<void>;
}
