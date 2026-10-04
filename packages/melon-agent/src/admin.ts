/**
 * `@melon-ai/agent/admin` —— 后台：额度（通用策略、单独策略、不限；按天、滚动时间窗）、花费汇总、站点设置，
 * 自带管理页面与接口，宿主挂到自己的 HTTP 服务上。
 *
 * ```ts
 * import { createAdmin } from '@melon-ai/agent/admin';
 * import { openSqliteAdminStore } from '@melon-ai/agent/sqlite';
 * const admin = createAdmin({ store: openSqliteAdminStore({ file: 'admin.db' }), principals, auth });
 * const agent = await createAgent({ ...admin.meter(userId), ... });   // 花钱前查额度、每笔用量记进后台
 * const handle = admin.handler('/admin');
 * http.createServer((req, res) => handle(req, res) || app(req, res));
 * ```
 */
export * from '@melon-ai/admin';
export { InMemoryAdminStore } from '@melon-ai/store';
