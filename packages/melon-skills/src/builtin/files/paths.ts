import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SENSITIVE_HOME_PATHS } from '@melon-ai/core';

/** 本地文件的「始终允许」记在这个名下：列目录、找文件、读文件共用一份，按文件夹授权。 */
export const FILES_GRANT_KEY = 'files';

/** `~/Downloads` → 绝对路径；解析掉 `..`、去掉末尾的 `/`；存在的话取真实路径（符号链接）。 */
export function canonical(p: string, home: string = homedir()): string {
  const s = String(p ?? '').trim();
  const expanded = s === '~' ? home : s.startsWith('~/') ? join(home, s.slice(2)) : s;
  const abs = resolve(isAbsolute(expanded) ? expanded : join(home, expanded));
  try { return realpathSync(abs); } catch { return abs; }
}

/** 给人看的路径：家目录缩写成 ~。 */
export const tilde = (p: string, home: string = homedir()): string => (p === home ? '~' : p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p);

/** 授权范围：`folder=/Users/me/Downloads`。人可读（记录页里能看懂「始终允许过哪些文件夹」）。 */
export const folderScope = (folder: string): string => `folder=${canonical(folder)}`;

/** 已授权的文件夹是否覆盖这次的（同一个，或这次的在它里面）。 */
export function folderCovers(granted: string, requested: string): boolean {
  if (!granted.startsWith('folder=') || !requested.startsWith('folder=')) return false;
  const g = granted.slice(7);
  const r = requested.slice(7);
  return r === g || r.startsWith(g.endsWith(sep) ? g : g + sep);
}

/** `inside` 是不是 `dir` 本身或在它里面。 */
export const within = (inside: string, dir: string): boolean => {
  const rel = relative(dir, inside);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** 受保护的位置：密钥、钥匙串、浏览器资料……（与沙箱同一份清单）+ 宿主给的（它自己存 key 的目录）。 */
export function protectedPaths(extra: readonly string[] = [], home: string = homedir()): readonly string[] {
  return [...SENSITIVE_HOME_PATHS.map((p) => join(home, p)), ...extra].map((p) => canonical(p, home));
}

/** 这个位置是否受保护：它在受保护的位置里。 */
export const isProtected = (p: string, prot: readonly string[]): boolean => prot.some((d) => within(p, d));

/** 编辑距离（短字符串，找近似的文件夹名用）。 */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * 不存在的路径：在它的上一级里找名字最像的（`~/Download` → `~/Downloads`、`~/documents` → `~/Documents`）。
 * 上一级也不存在、或没有像的，返回 null。
 */
export function nearest(p: string): string | null {
  const parent = dirname(p);
  if (!existsSync(parent)) return null;
  const want = basename(p).toLowerCase();
  let best: { name: string; d: number } | null = null;
  try {
    for (const name of readdirSync(parent)) {
      if (name.startsWith('.')) continue;
      const n = name.toLowerCase();
      const d = n === want ? 0 : n.startsWith(want) || want.startsWith(n) ? Math.abs(n.length - want.length) : distance(n, want);
      if (d <= Math.max(2, Math.floor(want.length / 4)) && (!best || d < best.d)) best = { name, d };
    }
  } catch { return null; }
  return best ? join(parent, best.name) : null;
}

export const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
