import type { StoreBundle } from '@melon-ai/core';
import {
  InMemoryEpisodeStore, InMemoryEventLog, InMemoryGrantStore, InMemoryIdempotencyStore,
  InMemoryScheduleStore, InMemoryTaskStore, InMemoryUsageLedger, InMemoryPriceStore, InMemoryCatalogStore, InMemoryCanvasStore,
} from './stores.js';
import {
  InMemoryArtifactStore, InMemoryAuditSink, InMemoryDeletion, InMemoryMemoryStore, InMemoryVectorIndex,
} from './content.js';

export * from './stores.js';
export * from './content.js';
export * from './admin.js';

export interface MemoryBundle extends StoreBundle {
  readonly audit: InMemoryAuditSink;
  readonly idempotency: InMemoryIdempotencyStore;
  readonly resolver: InMemoryDeletion;
}

export interface MemoryStorageOptions {
  /** embedding 维度。 */
  readonly dims?: number;
  readonly now?: () => number;
}

/**
 * 全套内存存储。**不传存储时的默认值** —— 宿主只装一个包就能跑起来。
 *
 * 进程退出即丢失，也没有事务回滚：`transaction` 只保证串行执行，不保证原子。
 * 适合试用、测试与不需要持久化的场景；要持久化用 `@melon-ai/store/sqlite`。
 */
export function memoryStorage(opts: MemoryStorageOptions = {}): MemoryBundle {
  const now = opts.now ?? (() => Date.now());
  const vectors = new InMemoryVectorIndex(opts.dims ?? 384);
  const memories = new InMemoryMemoryStore(vectors);
  const artifacts = new InMemoryArtifactStore(now);
  const episodes = new InMemoryEpisodeStore();
  const deletion = new InMemoryDeletion(memories, artifacts, episodes, vectors, now);
  // 串行化：并发的 transaction 按提交顺序依次执行，避免交错写入
  let chain: Promise<unknown> = Promise.resolve();
  return {
    tasks: new InMemoryTaskStore(),
    events: new InMemoryEventLog(now),
    episodes,
    memories,
    artifacts,
    grants: new InMemoryGrantStore(),
    schedules: new InMemoryScheduleStore(),
    vectors,
    audit: new InMemoryAuditSink(),
    idempotency: new InMemoryIdempotencyStore(now),
    purger: deletion,
    archive: deletion,
    resolver: deletion,
    usage: new InMemoryUsageLedger(),
    prices: new InMemoryPriceStore(),
    catalog: new InMemoryCatalogStore(),
    canvases: new InMemoryCanvasStore(),
    transaction: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn, fn);
      chain = run.catch(() => undefined);
      return run;
    },
    close: async () => {},
  };
}
