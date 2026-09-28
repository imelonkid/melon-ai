import type { AuditRecord, Hasher } from '@melon-ai/core';

/**
 * 参与哈希的字段，顺序固定。
 *
 * 只哈希**不可变的事实**。`seq` 和 `prevHash` 进链以固定顺序，
 * `resource.contentHash` 进链所以「被引用的负载被替换」也能被发现 ——
 * 这正是 §2.4 坑一说的：光有链只能证明记录没被改，证明不了引用的东西没被换。
 */
export function canonical(r: Omit<AuditRecord, 'hash'>): string {
  const dims = r.dimensions
    ? Object.keys(r.dimensions).sort().map((k) => `${k}=${String(r.dimensions![k])}`).join(',')
    : '';
  const basis = r.basis
    ? Object.keys(r.basis).sort().map((k) => `${k}=${String(r.basis![k])}`).join(',')
    : '';
  return [
    r.seq,
    r.at,
    `${r.actor.kind}:${r.actor.id}`,
    r.action,
    `${r.resource.kind}:${r.resource.ref}:${r.resource.contentHash ?? ''}`,
    r.outcome,
    r.traceId,
    r.spanId ?? '',
    r.taskId ?? '',
    dims,
    basis,
    r.prevHash ?? '',
  ].join('|');
}

export const hashRecord = (h: Hasher, r: Omit<AuditRecord, 'hash'>): string =>
  h.sha256(canonical(r));

export interface ChainBreak {
  readonly seq: number;
  readonly why: 'hash-mismatch' | 'prev-mismatch' | 'seq-gap';
}

/**
 * 校验哈希链。返回第一处断裂，完整则返回 null。
 *
 * 防篡改没有校验手段就只是装饰，所以这个函数必须存在并被定期调用。
 */
export function verifyChain(h: Hasher, rows: readonly AuditRecord[]): ChainBreak | null {
  let prev: AuditRecord | undefined;
  for (const r of rows) {
    if (prev && r.seq !== prev.seq + 1) return { seq: r.seq, why: 'seq-gap' };
    const expectedPrev = prev?.hash;
    if ((r.prevHash ?? undefined) !== expectedPrev) return { seq: r.seq, why: 'prev-mismatch' };
    const { hash, ...rest } = r;
    if (hashRecord(h, rest) !== hash) return { seq: r.seq, why: 'hash-mismatch' };
    prev = r;
  }
  return null;
}
