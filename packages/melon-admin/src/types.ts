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
  /** 新建用户（账号在宿主那边）：返回 id 和一次性初始密码，后台显示一次。不给就不显示「新建用户」。出错抛出，信息给管理员看。 */
  create?(input: { readonly username: string; readonly name: string }): Promise<{ readonly id: string; readonly initialPassword: string }> | { readonly id: string; readonly initialPassword: string };
  /** 重置密码：返回新的一次性初始密码。不给就不显示「重置密码」。 */
  resetPassword?(id: string): Promise<string> | string;
}

/** 共享资源的一个表单字段（宿主描述，后台照着画）。 */
export interface ResourceField {
  readonly key: string;
  readonly label: string;
  /** 密钥类：存起来，后台只显示打码，回传 `__KEEP__` 表示不改。 */
  readonly secret?: boolean;
  readonly optional?: boolean;
  readonly placeholder?: string;
  readonly help?: string;
}

/** 一家厂商（或一种服务）要填什么。 */
export interface ResourceVendor {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
  readonly fields: readonly ResourceField[];
}

/**
 * 一类共享资源（宿主统一提供给所有用户的）：比如「模型」「搜索」。
 * 后台只按描述存配置、画表单；配置怎么用（造模型、接搜索）是宿主的事。
 */
export interface ResourceSection {
  readonly kind: string;
  readonly title: string;
  readonly note?: string;
  /** 能不能同时启用多家（模型可以好几家，搜索一般只用一家）。默认可以。 */
  readonly multiple?: boolean;
  readonly vendors: readonly ResourceVendor[];
}

/** 存下来的一家的配置。 */
export interface ResourceConfig {
  readonly enabled: boolean;
  readonly values: Readonly<Record<string, string>>;
}

/** 全部共享资源的配置：`kind → 厂商 id → 配置`。 */
export type ResourceConfigs = Readonly<Record<string, Readonly<Record<string, ResourceConfig>>>>;

/** 宿主提供的连通性测试（后台「测试」按钮）。 */
export type ResourceTestFn = (kind: string, vendorId: string, values: Readonly<Record<string, string>>) => Promise<{ readonly ok: boolean; readonly message: string }>;

/** 路由规则页：宿主告诉后台有哪些任务类别、能固定哪些模型。规则怎么用由宿主决定（通常交给引擎的 `RoutingRule.byGroup`）。 */
export interface RoutingSpec {
  readonly classes: readonly { readonly id: string; readonly label: string; readonly note?: string }[];
  /** 可选的档次（默认 基础 / 标准 / 强）。 */
  readonly tiers?: readonly { readonly id: string; readonly label: string }[];
  /** 能固定的模型（key 和显示名），比如共享模型里现在可用的那些。 */
  readonly options?: () => Promise<readonly { readonly key: string; readonly label: string }[]> | readonly { readonly key: string; readonly label: string }[];
}

/** 一类任务的规则。 */
export interface RoutingRuleConfig {
  readonly minTier?: string;
  readonly pin?: string;
}

/** 管理员登录：宿主校验（只让它认可的管理员进）。不通过返回 null。 */
export interface AdminIdentity {
  readonly name: string;
  /** 还在用初始密码：登录后只能先改密码，别的都不让做。 */
  readonly mustChangePassword?: boolean;
}

/**
 * 管理员登录。不给（推荐）就用后台自带的管理员账号（`BuiltinAdminAuth`）：和宿主的用户账号分开，
 * 第一次启动 `admin.bootstrap()` 建初始账号，第一次登录必须改密码。
 */
export interface AdminAuth {
  verify(username: string, password: string): Promise<AdminIdentity | null> | AdminIdentity | null;
  /** 改密码（要原密码）。不合格抛错，错误信息直接给用户看。不给就不能在后台改密码。 */
  changePassword?(username: string, oldPassword: string, newPassword: string): Promise<void> | void;
}

/** 这一笔算不算额度（模型的花费带账户与分组，比如宿主只算「共享」那组）。 */
export type CountsFn = (spend: { readonly kind: 'model' | 'tool'; readonly vendor: string; readonly account?: string; readonly group?: string }) => boolean;

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
  /** 管理员登录的校验；不给就用后台自带的管理员账号。 */
  readonly auth?: AdminAuth;
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
  /** 共享资源（宿主统一提供给用户的模型、搜索……）：给了就有「共享资源」页。 */
  readonly resources?: readonly ResourceSection[];
  readonly testResource?: ResourceTestFn;
  /** 共享模型的路由规则：给了就有「路由规则」页。 */
  readonly routing?: RoutingSpec;
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
  /** 共享资源与路由规则（宿主配了才有）。 */
  readonly shared: SharedApi | null;
}

/** 给页面看的一家：密钥只给打码和「填没填」。 */
export interface ResourceView {
  readonly enabled: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly filled: Readonly<Record<string, boolean>>;
}

/** 接口层要用的共享资源能力（`SharedResources` 实现它）。 */
export interface SharedApi {
  readonly sections: readonly ResourceSection[];
  readonly routing?: RoutingSpec | undefined;
  view(): Promise<Record<string, Record<string, ResourceView>>>;
  set(kind: string, vendorId: string, patch: { readonly enabled?: boolean; readonly values?: Readonly<Record<string, unknown>> }): Promise<void>;
  runTest(kind: string, vendorId: string, values: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; message: string }>;
  routingRules(): Promise<Record<string, RoutingRuleConfig>>;
  setRoutingRules(rules: Readonly<Record<string, RoutingRuleConfig>>): Promise<Record<string, RoutingRuleConfig>>;
}
