import { createHash } from 'node:crypto';
import type {
  AuditRecord, Hasher, ResolvedResource, ResourceRef, ResourceResolver, ResourceTombstone,
} from '@melon-ai/core';
import { InMemoryAuditSink as AuditSinkBase } from '@melon-ai/store';

export class NodeHasher implements Hasher {
  sha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }
}

/** 内存审计 sink 在 @melon-ai/store；这里只加一个测试专用的篡改方法。 */
export class InMemoryAuditSink extends AuditSinkBase {
  /** 测试用：篡改一条记录的内容但不更新哈希，模拟被改写。 */
  tamper(seq: number, mutate: (r: AuditRecord) => AuditRecord): void {
    const i = this.rows.findIndex((r) => r.seq === seq);
    if (i < 0) throw new Error(`no record with seq=${seq}`);
    this.rows[i] = mutate(this.rows[i]!);
  }
}

/** 内存解引用器。可以把某个 ref 标成已删除，用来测悬垂引用的行为。 */
export class InMemoryResolver implements ResourceResolver {
  private readonly payloads = new Map<string, { payload: unknown; contentHash?: string }>();
  private readonly tombstones = new Map<string, ResourceTombstone>();

  put(ref: ResourceRef, payload: unknown): this {
    this.payloads.set(ref.ref, ref.contentHash !== undefined
      ? { payload, contentHash: ref.contentHash }
      : { payload });
    return this;
  }
  kill(ref: ResourceRef, reason: ResourceTombstone['reason'], at = 0): this {
    this.payloads.delete(ref.ref);
    this.tombstones.set(ref.ref, { kind: ref.kind, ref: ref.ref, deletedAt: at, reason });
    return this;
  }

  async resolve(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, ResolvedResource>> {
    const out = new Map<string, ResolvedResource>();
    for (const r of refs) {
      const hit = this.payloads.get(r.ref);
      if (hit) {
        out.set(r.ref, {
          status: 'ok',
          payload: hit.payload,
          // 记录里的 contentHash 与当前负载对不上 → 负载在记录之后被改过
          contentHashMatches: r.contentHash === undefined || r.contentHash === hit.contentHash,
        });
        continue;
      }
      const tomb = this.tombstones.get(r.ref);
      out.set(r.ref, tomb ? { status: 'deleted', tombstone: tomb } : { status: 'missing' });
    }
    return out;
  }
}
