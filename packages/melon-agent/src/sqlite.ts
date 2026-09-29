/**
 * `@melon-ai/agent/sqlite` —— SQLite 持久化存储。需要宿主装 `better-sqlite3`。
 *
 * ```ts
 * import { sqlite } from '@melon-ai/agent/sqlite';
 * const agent = await createAgent({ storage: sqlite({ file: 'app.db' }), ... });
 * ```
 */
import { openSqliteStores } from '@melon-ai/store/sqlite';
import type { OpenStoresOptions, SqliteBundle } from '@melon-ai/store/sqlite';

export function sqlite(opts: OpenStoresOptions): SqliteBundle {
  return openSqliteStores(opts);
}
export { openSqliteStores };
export type { OpenStoresOptions, SqliteBundle };
