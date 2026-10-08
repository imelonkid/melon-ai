import type { AdminStore, Currency, SpendGuard, UsageRecord } from '@melon-ai/core';
import { QuotaBook, startOfDay } from './quota.js';
import type { AdminApi, AdminAuth, AdminOptions, CountsFn, DayRow, Overview, PrincipalSource, SiteSettings, UserRow } from './types.js';
import { adminHandler } from './http.js';
import { BuiltinAdminAuth } from './accounts.js';
import { SharedResources } from './resources.js';
import type { AdminRequest, AdminResponse } from './http.js';
import type { QuotaStatus } from './quota.js';

const SYMBOL: Record<Currency, string> = { CNY: '¥', USD: '$' };
const DAY = 86_400_000;

/**
 * 后台：额度、花费汇总、站点设置、用户名单（来自宿主）。
 *
 * 接入（每个用户一个引擎实例时）：
 * ```ts
 * const admin = createAdmin({ store, principals, auth });
 * createAgent({ ...admin.meter(userId, counts), ... });   // 花钱前检查 + 记账
 * const handle = admin.handler('/admin');
 * server.on('request', (req, res) => handle(req, res) || other(req, res));
 * ```
 */
export class Admin implements AdminApi {
  readonly quota: QuotaBook;
  /**
   * 共享资源（宿主统一提供给用户的模型、搜索……）与路由规则：`configs()` 拿明文配置造模型，`routingRules()` 拿规则，
   * `watch(cb)` 在管理员改了之后重新接。宿主没配 `resources` / `routing` 时为 null。
   */
  readonly shared: SharedResources | null;
  readonly currency: Currency;
  readonly symbol: string;
  private readonly o: AdminOptions;
  private readonly now: () => number;
  private readonly tz: number;
  private lastPurge = 0;

  constructor(o: AdminOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.currency = o.currency ?? 'CNY';
    this.symbol = SYMBOL[this.currency];
    this.quota = new QuotaBook({
      store: o.store, now: this.now, currencySymbol: this.symbol,
      ...(o.windows ? { windows: o.windows } : {}), ...(o.defaults ? { defaults: o.defaults } : {}), ...(o.reason ? { reason: o.reason } : {}),
    });
    this.authImpl = o.auth ?? new BuiltinAdminAuth(o.store);
    this.shared = o.resources?.length || o.routing ? new SharedResources(o.store, o.resources ?? [], o.testResource, o.routing) : null;
    const day = this.quota.windows.find((w) => w.kind === 'day') as { tzOffsetMinutes: number } | undefined;
    this.tz = day?.tzOffsetMinutes ?? 480;
  }

  get store(): AdminStore { return this.o.store; }
  get principals(): PrincipalSource { return this.o.principals; }
  get auth(): AdminAuth { return this.authImpl; }
  private readonly authImpl: AdminAuth;

  /**
   * 第一次启动：自带管理员账号一个都没有时建一个。
   * 部署时约定用环境变量 `MELON_ADMIN_USER` / `MELON_ADMIN_PASSWORD` 传进来（宿主读，引擎不碰 process.env）：
   * 没给用户名就叫 admin；没给密码就生成一次性初始密码返回（宿主打印出来，只这一次），第一次登录必须先改。
   * 给了密码的当作部署者自己定的，不强制改。已经有账号、或者登录由宿主校验，返回 null。
   */
  async bootstrap(initial: { username?: string | undefined; password?: string | undefined } = {}): Promise<{ username: string; password: string; generated: boolean } | null> {
    if (!(this.authImpl instanceof BuiltinAdminAuth)) return null;
    return this.authImpl.bootstrap(initial.username?.trim() || 'admin', initial.password || undefined);
  }

  /** 忘了密码：给自带管理员账号换一个一次性初始密码（下次登录必须改），返回新密码。没有这个账号抛错。 */
  async resetAdminPassword(username = 'admin'): Promise<string> {
    if (!(this.authImpl instanceof BuiltinAdminAuth)) throw new Error('管理员登录由宿主校验，请在宿主那边重置');
    return this.authImpl.reset(username);
  }

  /**
   * 给某个用户的引擎实例用：`spendGuard`（花钱前检查额度）+ `onUsage`（每笔用量记进后台）。
   * `counts` 决定哪些花费算额度（默认都算）；不算的照样记（概览里的调用次数要它），只是不扣额度。
   */
  meter(principal: string, counts: CountsFn = () => true): { spendGuard: SpendGuard; onUsage: (r: UsageRecord) => void } {
    return {
      spendGuard: (c) => (counts({
        kind: c.kind, vendor: c.vendor, ...(c.account !== undefined ? { account: c.account } : {}), ...(c.group !== undefined ? { group: c.group } : {}),
      }) ? this.quota.check(principal) : null),
      onUsage: (r) => {
        const kind = r.purpose === 'tool' ? 'tool' : 'model';
        const counted = counts({ kind, vendor: r.egress, ...(r.account !== undefined ? { account: r.account } : {}), ...(r.group !== undefined ? { group: r.group } : {}) });
        void this.record(principal, r, counted).catch(() => { /* 后台记账失败不影响任务 */ });
      },
    };
  }

  /** 记一笔用量（引擎的 `UsageRecord`）。 */
  async record(principal: string, r: UsageRecord, counted: boolean): Promise<void> {
    const rate = r.currency === this.currency ? 1 : (this.o.fx?.[r.currency] ?? (r.currency === 'USD' && this.currency === 'CNY' ? 7.2 : 1));
    const amount = r.billing === 'plan' ? 0 : r.cost * rate;
    await this.o.store.recordSpend({
      principal, at: r.at, amount, currency: this.currency, counted, kind: r.purpose === 'tool' ? 'tool' : 'model',
      vendor: r.egress, model: r.model, ok: r.ok,
    });
    const now = this.now();
    if (now - this.lastPurge > 3_600_000) {
      this.lastPurge = now;
      await this.o.store.purgeSpend(now - (this.o.retentionDays ?? 90) * DAY);
    }
  }

  status(principal: string): Promise<QuotaStatus> { return this.quota.status(principal); }

  /**
   * 后台的页面和接口，挂在 `basePath` 下（比如 `/admin`）。返回的函数：是后台的请求就处理并返回 true，否则返回 false。
   */
  handler(basePath: string): (req: AdminRequest, res: AdminResponse) => boolean {
    return adminHandler(this, { basePath, now: this.now });
  }

  async settings(): Promise<SiteSettings> {
    const s = ((await this.o.store.getSetting('site')) ?? {}) as Partial<SiteSettings>;
    return {
      siteName: typeof s.siteName === 'string' && s.siteName.trim() ? s.siteName : (this.o.siteName ?? 'melon-ai 管理后台'),
      theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
    };
  }

  async setSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
    const cur = await this.settings();
    const name = typeof patch.siteName === 'string' ? patch.siteName.replace(/\s+/g, ' ').trim().slice(0, 40) : cur.siteName;
    const theme = patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system' ? patch.theme : cur.theme;
    const next = { siteName: name || cur.siteName, theme };
    await this.o.store.setSetting('site', next);
    return next;
  }

  private dayKey(t: number): string {
    const d = new Date(t + this.tz * 60_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /** 按天汇总（当地日期），最近 `days` 天，含今天；没有花费的天也给一行。 */
  async daily(days: number, principal?: string): Promise<DayRow[]> {
    const today = startOfDay(this.now(), this.tz);
    const from = today - (days - 1) * DAY;
    const rows = await this.o.store.listSpend({ from, ...(principal !== undefined ? { principal } : {}) });
    const map = new Map<string, { counted: number; total: number; calls: number; tools: number; failed: number }>();
    for (let i = 0; i < days; i++) map.set(this.dayKey(from + i * DAY), { counted: 0, total: 0, calls: 0, tools: 0, failed: 0 });
    for (const r of rows) {
      const m = map.get(this.dayKey(r.at));
      if (!m) continue;
      m.total += r.amount; m.calls += 1;
      if (r.counted) m.counted += r.amount;
      if (r.kind === 'tool') m.tools += 1;
      if (!r.ok) m.failed += 1;
    }
    return [...map].map(([day, m]) => ({ day, ...m }));
  }

  async users(): Promise<UserRow[]> {
    const list = await this.o.principals.list();
    const today = startOfDay(this.now(), this.tz);
    const spend = await this.o.store.listSpend({ from: today });
    const out: UserRow[] = [];
    for (const p of list) {
      out.push({
        ...p, policy: await this.quota.policy(p.id), quota: await this.quota.status(p.id),
        todayCalls: spend.filter((e) => e.principal === p.id).length,
      });
    }
    return out;
  }

  async overview(): Promise<Overview> {
    const days = await this.daily(7);
    const t = days.at(-1)!;
    const users = await this.users();
    const used = (u: UserRow) => u.quota.windows[0]?.used ?? 0;
    return {
      today: { counted: t.counted, total: t.total, calls: t.calls, tools: t.tools, failed: t.failed },
      users: {
        total: users.length,
        active: users.filter((u) => u.status !== 'disabled').length,
        exhausted: users.filter((u) => !u.quota.unlimited && u.quota.windows.some((w) => w.limit !== undefined && w.used >= w.limit)).length,
      },
      days,
      top: users.filter((u) => used(u) > 0).sort((a, b) => used(b) - used(a)).slice(0, 5).map((u) => ({ id: u.id, name: u.name, windows: u.quota.windows })),
      service: this.o.service ? await this.o.service() : null,
    };
  }
}

export function createAdmin(o: AdminOptions): Admin {
  return new Admin(o);
}
