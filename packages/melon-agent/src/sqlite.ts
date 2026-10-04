/**
 * `@melon-ai/agent/sqlite` —— SQLite 持久化存储。需要宿主装 `better-sqlite3`。
 *
 * ```ts
 * import { sqlite } from '@melon-ai/agent/sqlite';
 * const agent = await createAgent({ storage: sqlite({ file: 'app.db' }), ... });
 * ```
 */
import { openSqliteStores, openSqliteAdminStore, SqliteAdminStore } from '@melon-ai/store/sqlite';
import type { OpenStoresOptions, SqliteBundle, OpenAdminStoreOptions } from '@melon-ai/store/sqlite';

export function sqlite(opts: OpenStoresOptions): SqliteBundle {
  return openSqliteStores(opts);
}
export { openSqliteStores };
/** 后台（`@melon-ai/agent/admin`）的存储：宿主全局一个库文件，跨所有用户的引擎实例。 */
export { openSqliteAdminStore, SqliteAdminStore };
export type { OpenStoresOptions, SqliteBundle, OpenAdminStoreOptions };
