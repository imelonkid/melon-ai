import type {
  Archive, Purger, PurgeRequest, PurgeResult, ResourceRef, ResourceResolver,
  ResolvedResource, ResourceTombstone,
} from '@melon-ai/core';
import type { SqliteContext } from './db.js';
import type { SqliteArtifactStore } from './artifacts.js';
import { json, unjson } from './db.js';

/**
 * 物理删除。只服务 §2.5 的 retention 与 privacy 两种动因；
 * supersede 走版本链，不进这里。
 */
export class SqlitePurger implements Purger {
  constructor(
    private readonly cx: SqliteContext,
    private readonly artifacts: SqliteArtifactStore,
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
      if (req.motive === 'retention') await this.archiveOne(ref);

      let ok = false;
      switch (ref.kind) {
        case 'artifact':
          ok = this.artifacts.purgeOne(ref.ref);
          break;
        case 'memory': {
          const row = this.cx.db.prepare('SELECT rowid FROM memories WHERE id=?')
            .get(ref.ref) as { rowid: number } | undefined;
          if (row) {
            // 派生数据必须一并物理删：留着会继续被召回、白占预算
            derivedRemoved += this.cx.db.prepare('DELETE FROM memories_fts WHERE rowid=?').run(row.rowid).changes;
            derivedRemoved += this.cx.db.prepare('DELETE FROM vectors WHERE id=?').run(ref.ref).changes;
            ok = this.cx.db.prepare('DELETE FROM memories WHERE id=?').run(ref.ref).changes > 0;
          }
          break;
        }
        case 'episode':
          this.cx.db.prepare('DELETE FROM entries WHERE episode_id=?').run(ref.ref);
          ok = this.cx.db.prepare('DELETE FROM episodes WHERE id=?').run(ref.ref).changes > 0;
          break;
        default:
          skipped.push({ ref: ref.ref, why: `不支持的资源类型：${ref.kind}` });
          continue;
      }

      if (!ok) { skipped.push({ ref: ref.ref, why: '资源不存在' }); continue; }
      this.cx.db.prepare(
        'INSERT OR REPLACE INTO tombstones (kind, ref, deleted_at, reason) VALUES (?,?,?,?)',
      ).run(t.kind, t.ref, t.deletedAt, t.reason);
      tombstones.push(t);
    }
    return { tombstones, derivedRemoved, skipped };
  }

  private async archiveOne(ref: ResourceRef): Promise<void> {
    const payload = ref.kind === 'memory'
      ? this.cx.db.prepare('SELECT * FROM memories WHERE id=?').get(ref.ref)
      : this.cx.db.prepare('SELECT * FROM artifacts WHERE ref=?').get(ref.ref);
    if (!payload) return;
    this.cx.db.prepare(
      'INSERT OR REPLACE INTO archive (kind, ref, payload, archived_at) VALUES (?,?,?,?)',
    ).run(ref.kind, ref.ref, json(payload), this.now());
  }
}

export class SqliteArchive implements Archive {
  constructor(private readonly cx: SqliteContext, private readonly now: () => number = () => Date.now()) {}

  async archive(refs: readonly ResourceRef[]): Promise<number> {
    let n = 0;
    for (const r of refs) {
      const row = this.cx.db.prepare('SELECT * FROM memories WHERE id=?').get(r.ref)
        ?? this.cx.db.prepare('SELECT * FROM artifacts WHERE ref=?').get(r.ref);
      if (!row) continue;
      this.cx.db.prepare('INSERT OR REPLACE INTO archive (kind, ref, payload, archived_at) VALUES (?,?,?,?)')
        .run(r.kind, r.ref, json(row), this.now());
      n += 1;
    }
    return n;
  }

  async restore(refs: readonly ResourceRef[]): Promise<number> {
    let n = 0;
    for (const r of refs) {
      const row = this.cx.db.prepare('SELECT payload FROM archive WHERE kind=? AND ref=?')
        .get(r.kind, r.ref) as { payload: string } | undefined;
      if (!row) continue;
      // 只支持 memory 的恢复；artifact 的负载已随文件删除，恢复没有意义
      if (r.kind === 'memory') {
        const m = unjson<Record<string, unknown>>(row.payload);
        const cols = Object.keys(m).filter((k) => k !== 'rowid');
        this.cx.db.prepare(
          `INSERT OR REPLACE INTO memories (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        ).run(...cols.map((c) => m[c] as never));
        this.cx.db.prepare('DELETE FROM tombstones WHERE kind=? AND ref=?').run(r.kind, r.ref);
        n += 1;
      }
    }
    return n;
  }

  async size(): Promise<{ rows: number; bytes: number }> {
    const r = this.cx.db.prepare('SELECT COUNT(*) rows, COALESCE(SUM(LENGTH(payload)),0) bytes FROM archive')
      .get() as { rows: number; bytes: number };
    return r;
  }
}

/** 解引用。审计里只有 ref，取负载要经过这里。 */
export class SqliteResolver implements ResourceResolver {
  constructor(private readonly cx: SqliteContext, private readonly artifacts: SqliteArtifactStore) {}

  async resolve(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, ResolvedResource>> {
    const out = new Map<string, ResolvedResource>();
    for (const r of refs) {
      const payload = r.kind === 'artifact'
        ? await this.artifacts.stat(r.ref as never)
        : this.cx.db.prepare('SELECT * FROM memories WHERE id=?').get(r.ref) ?? null;
      if (payload) {
        out.set(r.ref, { status: 'ok', payload, contentHashMatches: true });
        continue;
      }
      const tomb = this.cx.db.prepare('SELECT * FROM tombstones WHERE kind=? AND ref=?')
        .get(r.kind, r.ref) as { kind: string; ref: string; deleted_at: number; reason: string } | undefined;
      out.set(r.ref, tomb
        ? { status: 'deleted', tombstone: {
            kind: tomb.kind, ref: tomb.ref, deletedAt: tomb.deleted_at,
            reason: tomb.reason as ResourceTombstone['reason'],
          } }
        : { status: 'missing' });
    }
    return out;
  }
}
