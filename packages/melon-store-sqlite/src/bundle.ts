import type { StoreBundle } from '@melon-ai/core';
import { SqliteContext } from './db.js';
import type { OpenOptions } from './db.js';
import {
  SqliteEpisodeStore, SqliteEventLog, SqliteGrantStore, SqliteIdempotencyStore, SqliteTaskStore,
} from './stores.js';
import { SqliteArtifactStore } from './artifacts.js';
import { SqliteMemoryStore, SqliteVectorIndex } from './memories.js';
import { SqliteAuditSink } from './audit.js';
import { SqliteArchive, SqlitePurger, SqliteResolver } from './deletion.js';

export interface SqliteBundle extends StoreBundle {
  readonly audit: SqliteAuditSink;
  readonly idempotency: SqliteIdempotencyStore;
  readonly resolver: SqliteResolver;
  readonly context: SqliteContext;
}

export interface OpenStoresOptions extends OpenOptions {
  /** embedding 维度。必须与实际用的 Embedder 一致，否则向量写入会被拒。 */
  readonly dims?: number;
  readonly now?: () => number;
}

/**
 * 打开全套 SQLite 存储。
 *
 * 宿主换基础设施就是换这一行 —— 所有实现都只依赖 `@melon-ai/core` 的端口。
 */
export function openSqliteStores(opts: OpenStoresOptions): SqliteBundle {
  const cx = new SqliteContext(opts);
  const now = opts.now ?? (() => Date.now());
  const artifacts = new SqliteArtifactStore(cx, now);
  return {
    context: cx,
    tasks: new SqliteTaskStore(cx),
    events: new SqliteEventLog(cx, now),
    episodes: new SqliteEpisodeStore(cx),
    memories: new SqliteMemoryStore(cx),
    artifacts,
    grants: new SqliteGrantStore(cx),
    vectors: new SqliteVectorIndex(cx, opts.dims ?? 384),
    audit: new SqliteAuditSink(cx),
    idempotency: new SqliteIdempotencyStore(cx, now),
    purger: new SqlitePurger(cx, artifacts, now),
    archive: new SqliteArchive(cx, now),
    resolver: new SqliteResolver(cx, artifacts),
    transaction: (fn) => cx.transaction(fn),
    close: async () => { cx.close(); },
  };
}
