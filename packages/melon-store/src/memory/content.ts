import type {
  Archive, ArtifactMeta, ArtifactRef, ArtifactStore, AuditAction, AuditQuery, AuditRecord, AuditSink,
  Memory, MemoryId, MemoryQuery, MemoryStore, PurgeRequest, PurgeResult, Purger, ResolvedResource,
  ResourceRef, ResourceResolver, ResourceTombstone, Scored, TaskId, VectorIndex,
} from '@melon-ai/core';
import { asArtifactRef } from '@melon-ai/core';
import type { InMemoryEpisodeStore } from './stores.js';

/** 内存存储：artifact、长期记忆、向量、审计，以及删除与归档。 */

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly rows = new Map<string, { meta: ArtifactMeta; data: Uint8Array }>();
  private n = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(taskId: TaskId, data: Uint8Array | string, meta: { mime: string; summary: string }): Promise<ArtifactRef> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ref = asArtifactRef(`art-${++this.n}`);
    this.rows.set(ref, {
      data: bytes,
      meta: { ref, taskId, mime: meta.mime, bytes: bytes.byteLength, summary: meta.summary, createdAt: this.now() },
    });
    return ref;
  }
  async read(ref: ArtifactRef, range?: { offset: number; length: number }): Promise<Uint8Array> {
    const row = this.rows.get(ref);
    if (!row) throw new Error(`no artifact ${ref}`);
    return range ? row.data.slice(range.offset, range.offset + range.length) : row.data;
  }
  async stat(ref: ArtifactRef): Promise<ArtifactMeta | null> {
    return this.rows.get(ref)?.meta ?? null;
  }
  async listByTask(taskId: TaskId): Promise<readonly ArtifactMeta[]> {
    return [...this.rows.values()].filter((r) => r.meta.taskId === taskId).map((r) => r.meta);
  }
  text(ref: ArtifactRef): string {
    return new TextDecoder().decode(this.rows.get(ref)!.data);
  }
  purge(ref: string): boolean { return this.rows.delete(ref); }
  get size(): number { return this.rows.size; }
}

/**
 * 长期记忆。关键词检索用朴素的词项命中计分 —— SQLite 版用 FTS5 的 bm25，
 * 两者分数不可比，但「命中的排前面、supersede 过的默认不出现」这些语义一致。
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly rows = new Map<string, { m: Memory; supersededBy?: MemoryId }>();
  /** privacy 删除要连向量一起删 —— 与 SQLite 版一致。 */
  constructor(private readonly vectors?: InMemoryVectorIndex) {}

  async put(m: Memory): Promise<void> {
    const cur = this.rows.get(m.id);
    this.rows.set(m.id, cur ? { ...cur, m: { ...cur.m, ...pick(m) } } : { m });
  }
  async get(id: MemoryId): Promise<Memory | null> { return this.rows.get(id)?.m ?? null; }
  async findBySubject(scope: Memory['scope'], subject: string, kind: Memory['kind']): Promise<readonly Memory[]> {
    return [...this.rows.values()]
      .filter((r) => !r.supersededBy && r.m.scope === scope && r.m.subject === subject && r.m.kind === kind)
      .map((r) => r.m);
  }
  async search(q: MemoryQuery): Promise<readonly Scored<Memory>[]> {
    const pool = [...this.rows.values()]
      .filter((r) => q.activeOnly === false || !r.supersededBy)
      .map((r) => r.m)
      .filter((m) => m.scope === q.scope)
      .filter((m) => q.agentId === undefined || m.agentId === q.agentId)
      .filter((m) => !q.kinds || q.kinds.length === 0 || q.kinds.includes(m.kind))
      .filter((m) => q.subject === undefined || m.subject === q.subject);
    const text = q.text?.trim();
    if (!text) {
      return pool
        .sort((a, b) => b.importance - a.importance || b.lastUsedAt - a.lastUsedAt)
        .slice(0, q.limit)
        .map((m) => ({ item: m, score: m.importance }));
    }
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    return pool
      .map((m) => {
        const hay = `${m.statement} ${m.subject}`.toLowerCase();
        const score = terms.filter((t) => hay.includes(t)).length + (hay.includes(text.toLowerCase()) ? 1 : 0);
        return { item: m, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit);
  }
  /** 标记替代关系，**不物理删除** —— §2.5 的 supersede 动因。 */
  async supersede(oldId: MemoryId, newId: MemoryId): Promise<void> {
    const r = this.rows.get(oldId);
    if (r) this.rows.set(oldId, { ...r, supersededBy: newId });
  }
  async touch(ids: readonly MemoryId[], at: number): Promise<void> {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r) this.rows.set(id, { ...r, m: { ...r.m, lastUsedAt: at, useCount: r.m.useCount + 1 } });
    }
  }
  /** 按来源任务物理删除 —— §2.5 的 privacy 动因，连向量一起删。 */
  async forgetByTask(taskId: TaskId): Promise<number> {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.m.provenance.taskId !== taskId) continue;
      this.rows.delete(id);
      await this.vectors?.remove(id);
      n += 1;
    }
    return n;
  }
  /** 给清理用。返回是否删到了。 */
  purge(id: string): boolean { return this.rows.delete(id); }
  raw(id: string): Memory | undefined { return this.rows.get(id)?.m; }
  restore(m: Memory): void { this.rows.set(m.id, { m }); }
}

/** 与 SQLite 版的 ON CONFLICT DO UPDATE 一致：重复 put 只更新这几个字段。 */
const pick = (m: Memory) => ({
  statement: m.statement, confidence: m.confidence, importance: m.importance,
  lastUsedAt: m.lastUsedAt, useCount: m.useCount,
});

/** 暴力余弦。与 SQLite 版同样的取舍：单用户量级够用。 */
export class InMemoryVectorIndex implements VectorIndex {
  private readonly rows = new Map<string, Float32Array>();
  constructor(readonly dims: number = 384) {}

  async upsert(id: string, vector: Float32Array): Promise<void> {
    if (vector.length !== this.dims) throw new Error(`向量维度不符：期望 ${this.dims}，收到 ${vector.length}`);
    this.rows.set(id, vector);
  }
  async query(vector: Float32Array, k: number): Promise<readonly Scored<string>[]> {
    return [...this.rows.entries()]
      .map(([id, v]) => ({ item: id, score: cosine(vector, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  async remove(id: string): Promise<void> { this.rows.delete(id); }
  get size(): number { return this.rows.size; }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * 审计 sink。`query` **按 seq 倒序**返回（最新在前）—— 审计的常见读法是「最近发生了什么」。
 * 哈希链校验在 @melon-ai/audit；这里只查序号连续性。
 */
export class InMemoryAuditSink implements AuditSink {
  readonly rows: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> { this.rows.push(record); }

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
    const ordered = [...this.rows].filter((r) => r.seq > fromSeq).sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.seq !== ordered[i - 1]!.seq + 1) return ordered[i]!.seq;
    }
    return null;
  }
}

/** 删除、归档、解引用共用的内存状态：墓碑与归档区。 */
export class InMemoryDeletion implements Purger, Archive, ResourceResolver {
  private readonly tombstones = new Map<string, ResourceTombstone>();
  private readonly archived = new Map<string, { kind: string; payload: unknown }>();

  constructor(
    private readonly memories: InMemoryMemoryStore,
    private readonly artifacts: InMemoryArtifactStore,
    private readonly episodes: InMemoryEpisodeStore,
    private readonly vectors: InMemoryVectorIndex,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async purge(req: PurgeRequest): Promise<PurgeResult> {
    const tombstones: ResourceTombstone[] = [];
    const skipped: { ref: string; why: string }[] = [];
    let derivedRemoved = 0;
    for (const ref of req.refs) {
      const t: ResourceTombstone = {
        kind: ref.kind, ref: ref.ref, deletedAt: this.now(),
        reason: req.motive === 'privacy' ? 'privacy-optout' : 'retention',
      };
      if (req.dryRun) { tombstones.push(t); continue; }
      // retention 先归档留恢复窗口；privacy 不经过归档 —— 经过了就等于没删
      if (req.motive === 'retention') await this.archive([ref]);
      let ok = false;
      switch (ref.kind) {
        case 'artifact': ok = this.artifacts.purge(ref.ref); break;
        case 'memory':
          if (this.vectors.size > 0) { await this.vectors.remove(ref.ref); derivedRemoved += 1; }
          ok = this.memories.purge(ref.ref);
          break;
        case 'episode': ok = this.episodes.purge(ref.ref); break;
        default:
          skipped.push({ ref: ref.ref, why: `不支持的资源类型：${ref.kind}` });
          continue;
      }
      if (!ok) { skipped.push({ ref: ref.ref, why: '资源不存在' }); continue; }
      this.tombstones.set(`${t.kind}|${t.ref}`, t);
      tombstones.push(t);
    }
    return { tombstones, derivedRemoved, skipped };
  }

  async archive(refs: readonly ResourceRef[]): Promise<number> {
    let n = 0;
    for (const r of refs) {
      const payload = r.kind === 'memory' ? this.memories.raw(r.ref) : await this.artifacts.stat(r.ref as ArtifactRef);
      if (!payload) continue;
      this.archived.set(`${r.kind}|${r.ref}`, { kind: r.kind, payload });
      n += 1;
    }
    return n;
  }

  /** 只支持 memory 的恢复；artifact 的负载已随删除丢失，恢复没有意义（与 SQLite 版一致）。 */
  async restore(refs: readonly ResourceRef[]): Promise<number> {
    let n = 0;
    for (const r of refs) {
      const row = this.archived.get(`${r.kind}|${r.ref}`);
      if (!row || r.kind !== 'memory') continue;
      this.memories.restore(row.payload as Memory);
      this.tombstones.delete(`${r.kind}|${r.ref}`);
      n += 1;
    }
    return n;
  }

  async size(): Promise<{ rows: number; bytes: number }> {
    let bytes = 0;
    for (const v of this.archived.values()) bytes += JSON.stringify(v.payload).length;
    return { rows: this.archived.size, bytes };
  }

  async resolve(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, ResolvedResource>> {
    const out = new Map<string, ResolvedResource>();
    for (const r of refs) {
      const payload = r.kind === 'artifact' ? await this.artifacts.stat(r.ref as ArtifactRef) : this.memories.raw(r.ref);
      if (payload) { out.set(r.ref, { status: 'ok', payload, contentHashMatches: true }); continue; }
      const tomb = this.tombstones.get(`${r.kind}|${r.ref}`);
      out.set(r.ref, tomb ? { status: 'deleted', tombstone: tomb } : { status: 'missing' });
    }
    return out;
  }
}
