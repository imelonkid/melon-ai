import type {
  AuditDraft, AuditQuery, AuditRecord, AuditRecorder, AuditSink, Clock, Hasher, Logger,
} from '@melon-ai/core';
import { hashRecord, verifyChain } from './chain.js';
import type { ChainBreak } from './chain.js';
import { assertRedacted } from './redact.js';

export interface RecorderDeps {
  readonly sink: AuditSink;
  readonly hasher: Hasher;
  readonly clock: Clock;
  readonly logger?: Logger;
}

/**
 * 审计记录器。
 *
 * 领域模块只认识 `AuditRecorder` 端口；哈希链、脱敏、序号这些都在这里补齐，
 * 调用方不需要也不应该关心。
 *
 * **写入失败必须让调用方知道。** 审计不能「尽力而为」——
 * 如果一次对外发送没被记下来，事后就无法证明它发生过，
 * 而这正是审计存在的理由。所以这里不吞异常。
 */
export class ChainedRecorder implements AuditRecorder {
  private seq = 0;
  private prevHash: string | undefined;
  private loaded = false;

  constructor(private readonly deps: RecorderDeps) {}

  /** 从 sink 恢复链尾。进程重启后必须调用，否则会从 seq=1 重新开始、直接把链写断。 */
  async resume(): Promise<void> {
    this.prevHash = await this.deps.sink.lastHash();
    const rows = await this.deps.sink.query({ limit: 1 });
    this.seq = rows[0]?.seq ?? 0;
    this.loaded = true;
  }

  async record(draft: AuditDraft): Promise<void> {
    if (!this.loaded) {
      throw new Error('ChainedRecorder 未 resume()：会从 seq=1 重写并把哈希链写断');
    }
    assertRedacted(draft);
    const withoutHash: Omit<AuditRecord, 'hash'> = {
      ...draft,
      seq: ++this.seq,
      at: draft.at || this.deps.clock.now(),
      ...(this.prevHash !== undefined ? { prevHash: this.prevHash } : {}),
    };
    const hash = hashRecord(this.deps.hasher, withoutHash);
    const record: AuditRecord = { ...withoutHash, hash };
    await this.deps.sink.append(record);
    this.prevHash = hash;
  }

  query(q: AuditQuery): Promise<readonly AuditRecord[]> {
    return this.deps.sink.query(q);
  }

  /** 定期跑。防篡改没有校验就只是装饰。 */
  async verify(): Promise<ChainBreak | null> {
    const rows = await this.deps.sink.query({ limit: Number.MAX_SAFE_INTEGER });
    const ordered = [...rows].sort((a, b) => a.seq - b.seq);
    const broken = verifyChain(this.deps.hasher, ordered);
    if (broken) {
      this.deps.logger?.log('error', '审计哈希链断裂', { seq: broken.seq, why: broken.why });
    }
    return broken;
  }
}
