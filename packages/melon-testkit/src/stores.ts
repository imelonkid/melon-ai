/**
 * 内存存储的实现在 @melon-ai/store（引擎的默认存储），这里只做测试需要的调整：
 * 时间默认固定为 0，断言才稳定。
 */
import {
  InMemoryArtifactStore as ArtifactBase,
  InMemoryEventLog as EventLogBase,
  InMemoryIdempotencyStore as IdempotencyBase,
} from '@melon-ai/store';

export {
  InMemoryTaskStore, InMemoryGrantStore, InMemoryEpisodeStore, InMemoryScheduleStore,
  InMemoryMemoryStore, InMemoryVectorIndex, memoryStorage,
} from '@melon-ai/store';

export class InMemoryEventLog extends EventLogBase {
  constructor(now: () => number = () => 0) { super(now); }
}

export class InMemoryArtifactStore extends ArtifactBase {
  constructor(now: () => number = () => 0) { super(now); }
}

export class InMemoryIdempotencyStore extends IdempotencyBase {
  constructor(now: () => number = () => 0) { super(now); }
}
