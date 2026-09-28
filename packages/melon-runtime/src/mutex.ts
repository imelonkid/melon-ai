/**
 * 按键串行化。
 *
 * 事件日志是**单写者**语义（`append` 校验 `expectedSeq`），
 * 所以同一个任务的推进必须排队 —— 否则两条并发路径都会拿到同一个 seq，
 * 一方必然抛 ConflictError，表现为随机失败。
 *
 * 不同任务之间不互斥：单机 O(10) 活跃任务，按任务串行完全够。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // 前一个失败不能阻塞后一个
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }

  get pending(): number { return this.tails.size; }
}
