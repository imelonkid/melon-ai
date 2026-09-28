import { createHash } from 'node:crypto';
import type {
  AuditAction, AuditQuery, AuditRecord, AuditSink, Hasher, ResolvedResource,
  ResourceRef, ResourceResolver, ResourceTombstone,
} from '@melon-ai/core';

export class NodeHasher implements Hasher {
  sha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }
}

/**
 * 内存审计 sink。
 *
 * `query` **按 seq 倒序**返回（最新在前）—— 审计的常见读法是「最近发生了什么」。
 * 校验哈希链需要正序，由调用方排序。
 */
export class InMemoryAuditSink implements AuditSink {
  readonly rows: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    this.rows.push(record);
  }

  async query(q: AuditQuery): Promise<readonly AuditRecord[]> {
    let out = [...this.rows].sort((a, b) => b.seq - a.seq);
    if (q.actor) out = out.filter((r) => r.actor.kind === q.actor!.kind && r.actor.id === q.actor!.id);
    if (q.actions) out = out.filter((r) => q.actions!.includes(r.action));
    if (q.resourceKind) out = out.filter((r) => r.resource.kind === q.resourceKind);
    if (q.resourceRef) out = out.filter((r) => r.resource.ref === q.resourceRef);
    if (q.taskId) out = out.filter((r) => r.taskId === q.taskId);
    if (q.traceId) out = out.filter((r) => r.traceId === q.traceId);
    if (q.from !== undefined) out = out.filter((r) => r.at >= q.from!);
    if (q.to !== undefined) out = out.filter((r) => r.at <= q.to!);
    return out.slice(0, q.limit);
  }

  async lastHash(): Promise<string | undefined> {
    return this.rows.length === 0 ? undefined : this.rows[this.rows.length - 1]!.hash;
  }

  async prune(before: number, keep: readonly AuditAction[]): Promise<number> {
    const before0 = this.rows.length;
    const kept = this.rows.filter((r) => r.at >= before || keep.includes(r.action));
    this.rows.length = 0;
    this.rows.push(...kept);
    return before0 - this.rows.length;
  }

  async verify(fromSeq = 0): Promise<number | null> {
    // 真实校验在 @melon-ai/audit 的 verifyChain；这里只查序号连续性
    const ordered = [...this.rows].filter((r) => r.seq > fromSeq).sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.seq !== ordered[i - 1]!.seq + 1) return ordered[i]!.seq;
    }
    return null;
  }

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
