import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactMeta, ArtifactRef, ArtifactStore, TaskId } from '@melon-ai/core';
import { asArtifactRef } from '@melon-ai/core';
import type { SqliteContext } from './db.js';

/**
 * artifact 存储。
 *
 * **负载落文件系统，表里只存元信息** —— 别把大 blob 塞进 SQLite：
 * 它会让整个数据库文件膨胀、VACUUM 变慢，而 artifact 恰恰是最大的一块。
 */
export class SqliteArtifactStore implements ArtifactStore {
  private n = 0;
  constructor(private readonly cx: SqliteContext, private readonly now: () => number = () => Date.now()) {
    mkdirSync(this.cx.artifactDir, { recursive: true });
    const r = this.cx.db.prepare('SELECT COUNT(*) c FROM artifacts').get() as { c: number };
    this.n = r.c;
  }

  async put(taskId: TaskId, data: Uint8Array | string, meta: { mime: string; summary: string }): Promise<ArtifactRef> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ref = asArtifactRef(`art-${Date.now()}-${++this.n}`);
    const path = join(this.cx.artifactDir, ref);
    writeFileSync(path, bytes);
    this.cx.db.prepare(
      'INSERT INTO artifacts (ref, task_id, mime, bytes, summary, created_at, path) VALUES (?,?,?,?,?,?,?)',
    ).run(ref, taskId, meta.mime, bytes.byteLength, meta.summary, this.now(), path);
    return ref;
  }

  async read(ref: ArtifactRef, range?: { offset: number; length: number }): Promise<Uint8Array> {
    const r = this.cx.db.prepare('SELECT path FROM artifacts WHERE ref=?').get(ref) as { path: string } | undefined;
    if (!r) throw new Error(`no artifact ${ref}`);
    const buf = readFileSync(r.path);
    return range ? new Uint8Array(buf.subarray(range.offset, range.offset + range.length)) : new Uint8Array(buf);
  }

  async stat(ref: ArtifactRef): Promise<ArtifactMeta | null> {
    const r = this.cx.db.prepare('SELECT * FROM artifacts WHERE ref=?').get(ref) as
      { ref: string; task_id: string; mime: string; bytes: number; summary: string; created_at: number } | undefined;
    if (!r) return null;
    return {
      ref: r.ref as ArtifactRef, taskId: r.task_id as TaskId, mime: r.mime,
      bytes: r.bytes, summary: r.summary, createdAt: r.created_at,
    };
  }

  async listByTask(taskId: TaskId): Promise<readonly ArtifactMeta[]> {
    const rows = this.cx.db.prepare('SELECT ref FROM artifacts WHERE task_id=? ORDER BY created_at')
      .all(taskId) as { ref: string }[];
    const out: ArtifactMeta[] = [];
    for (const r of rows) {
      const m = await this.stat(r.ref as ArtifactRef);
      if (m) out.push(m);
    }
    return out;
  }

  /** 物理删除负载。只由 Purger 调用（§2.5 的 retention / privacy 动因）。 */
  purgeOne(ref: string): boolean {
    const r = this.cx.db.prepare('SELECT path FROM artifacts WHERE ref=?').get(ref) as { path: string } | undefined;
    if (!r) return false;
    try { unlinkSync(r.path); } catch { /* 文件可能已不在 */ }
    this.cx.db.prepare('DELETE FROM artifacts WHERE ref=?').run(ref);
    return true;
  }
}
