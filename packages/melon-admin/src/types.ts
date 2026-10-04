import type { AdminStore, Currency, QuotaPolicy, QuotaWindow } from '@melon-ai/core';
import type { QuotaBook, QuotaStatus, ReasonFn, WindowStatus } from './quota.js';

/** 宿主的一个用户。引擎只认 id，其余是给后台显示的。 */
export interface Principal {
  readonly id: string;
  readonly name: string;
  readonly username?: string;
  /** 宿主的角色名（显示用），比如「管理员」「用户」。 */
  readonly role?: string;
  readonly status?: 'active' | 'disabled';
  readonly createdAt?: number;
  readonly lastActiveAt?: number | null;
}

export interface PrincipalSource {
  list(): Promise<readonly Principal[]> | readonly Principal[];
  /** 停用 / 启用。不给就不显示这个操作。 */
  setStatus?(id: string, status: 'active' | 'disabled'): Promise<void> | void;
}

/** 管理员登录：宿主校验（只让它认可的管理员进）。不通过返回 null。 */
export interface AdminAuth {
  verify(username: string, password: string): Promise<{ readonly name: string } | null> | { readonly name: string } | null;
}

/** 这一笔算不算额度。 */
export type CountsFn = (spend: { readonly kind: 'model' | 'tool'; readonly vendor: string }) => boolean;

export interface ServiceStatus {
  readonly ok: boolean;
  /** 一句话，比如「正常」「没有可用的模型」。 */
  readonly text: string;
  /** 补充，比如「DeepSeek · 智谱 · 博查」。 */
  readonly detail?: string;
}

export interface AdminOptions {
  readonly store: AdminStore;
  readonly principals: PrincipalSource;
  readonly auth: AdminAuth;
  /** 网站名称的初始值；管理员在「设置」里改了以改的为准。 */
  readonly siteName?: string;
  /** 后台用的币种（额度、花费都按它），默认人民币。 */
  readonly currency?: Currency;
  /** 1 个单位的各币种折多少后台币种。默认人民币下美元按 7.2。 */
  readonly fx?: Partial<Record<Currency, number>>;
  readonly windows?: readonly QuotaWindow[];
  /** 没设过通用策略时的金额（按时间窗 id），默认每天 2、每 5 小时 0.8。 */
  readonly defaults?: Readonly<Record<string, number>>;
  /** 额度用完时给用户的话。 */
  readonly reason?: ReasonFn;
  /** 概览里的「服务」卡片。 */
  readonly service?: () => Promise<ServiceStatus> | ServiceStatus;
  /** 花费流水留几天（默认 90）。 */
  readonly retentionDays?: number;
  readonly now?: () => number;
}

export interface SiteSettings {
  readonly siteName: string;
  readonly theme: 'system' | 'light' | 'dark';
}

export interface DayRow {
  /** 当地日期 YYYY-MM-DD。 */
  readonly day: string;
  /** 算额度的花费。 */
  readonly counted: number;
  /** 全部花费（含不算额度的）。 */
  readonly total: number;
  readonly calls: number;
  readonly tools: number;
  readonly failed: number;
}

export interface UserRow extends Principal {
  readonly policy: QuotaPolicy;
  readonly quota: QuotaStatus;
  readonly todayCalls: number;
}

export interface Overview {
  readonly today: { readonly counted: number; readonly total: number; readonly calls: number; readonly tools: number; readonly failed: number };
  readonly users: { readonly total: number; readonly active: number; readonly exhausted: number };
  readonly days: readonly DayRow[];
  readonly top: readonly { readonly id: string; readonly name: string; readonly windows: readonly WindowStatus[] }[];
  readonly service: ServiceStatus | null;
}

/** 接口层（http.ts）要用的后台能力。`Admin` 实现它；单独成型免得接口层反过来依赖 `Admin`（循环）。 */
export interface AdminApi {
  readonly quota: QuotaBook;
  readonly symbol: string;
  readonly principals: PrincipalSource;
  readonly auth: AdminAuth;
  settings(): Promise<SiteSettings>;
  setSettings(patch: Partial<SiteSettings>): Promise<SiteSettings>;
  overview(): Promise<Overview>;
  users(): Promise<UserRow[]>;
  daily(days: number, principal?: string): Promise<DayRow[]>;
  status(principal: string): Promise<QuotaStatus>;
}
