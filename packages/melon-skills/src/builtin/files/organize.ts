import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { FileChange, ToolOutput } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { defineTool } from '../../registry/define.js';
import type { Tool } from '../../registry/define.js';
import { canonical, folderCovers, folderScope, isDir, isProtected, nearest, tilde, within } from './paths.js';

/** 整理（移动、复制、新建、移到废纸篓）的「始终允许」记在这个名下，与查看的分开：允许查看不等于允许整理。 */
export const FILES_ORGANIZE_GRANT_KEY = 'files-organize';

/** 一次最多处理多少项：再多就分批，确认卡上的清单也看得过来。 */
const MAX_ITEMS = 200;
/** 能新建的文件类型：都是文本。 */
const WRITE_EXTS = new Set(['.md', '.txt', '.csv', '.json', '.html']);

export interface OrganizeOptions {
  /** 受保护的位置（与查看同一份）。 */
  readonly prot: readonly string[];
  /** 移到废纸篓：由宿主给（Electron 的 `shell.trashItem`），这样能在访达里「放回原处」。不给就没有删除工具。 */
  readonly trash?: (path: string) => Promise<void>;
  /** 能整理的范围，默认只有家目录（系统位置、别的磁盘不动）。 */
  readonly roots?: readonly string[];
}

interface Item { readonly from: string; readonly to: string }
type Problem = { message: string; hint?: string } | null;

/** 改动后的样子，撤销前核对用。 */
function stamp(p: string): { size: number; mtime: number } {
  const st = lstatSync(p);
  return { size: st.isDirectory() ? 0 : st.size, mtime: Math.round(st.mtimeMs) };
}

/**
 * 整理本机文件：新建文件夹、移动 / 重命名、复制、移到废纸篓、新建文本文件。
 *
 * - **一个文件夹为界**：每次调用指定一个文件夹，所有路径都相对它、不能越出它；授权也按它（含子文件夹）。
 * - **不覆盖**：目标已有同名的就退回给模型换名字；**不彻底删除**：删除只移到废纸篓，而且每次都要确认。
 * - **成批**：一次调用带一批，用户确认一次就看到完整清单，而不是点几十次。
 * - **记下改了什么**（`ToolOutput.changes`）：宿主据此「撤销」，见 `undoChanges`。
 * - **问之前先查**：源不存在、目标已存在、越界、受保护 —— 都在问用户之前退回给模型。
 */
export function organizeTools(opts: OrganizeOptions): Tool[] {
  const { prot } = opts;
  const roots = (opts.roots ?? [homedir()]).map((r) => canonical(r));

  /** 要整理的文件夹：存在、在家目录里（不是家目录本身以外的系统位置）、不受保护。 */
  const checkRoot = (folder: string): Problem => {
    const abs = canonical(folder);
    if (isProtected(abs, prot)) return { message: `${tilde(abs)} 是受保护的位置，不能改动`, hint: '告诉用户这个位置受保护。不要换别的办法绕过' };
    if (!roots.some((r) => within(abs, r))) return { message: `${tilde(abs)} 不在能整理的范围里（${roots.map((r) => tilde(r)).join('、')}）`, hint: '只能整理家目录里的文件夹' };
    if (!isDir(abs)) {
      const near = nearest(abs);
      return near && isDir(near)
        ? { message: `没有 ${tilde(abs)} 这个文件夹`, hint: `可能是 ${tilde(near)}：用它再试一次` }
        : { message: `没有 ${tilde(abs)} 这个文件夹`, hint: '问用户文件夹的准确位置' };
    }
    return null;
  };

  /** 文件夹里的一个位置（不解析符号链接本身 —— 移动的是链接，不是它指向的东西）。 */
  const inside = (root: string, rel: string): string => {
    const r = String(rel ?? '').trim();
    const full = resolve(root, r);
    if (!within(full, root) || full === root) throw new ToolError('INVALID_ARGS', `${rel} 不在 ${tilde(root)} 里`, { hint: '路径写相对这个文件夹的，如 PDF/合同.pdf' });
    if (isProtected(full, prot)) throw new ToolError('DENIED', `${tilde(full)} 是受保护的位置，不能改动`, { retriable: false, hint: '告诉用户这个位置受保护。不要换别的办法绕过' });
    return full;
  };

  /** 目标：写成「文件夹/」或已有的文件夹 → 放进去、名字不变。 */
  const target = (root: string, from: string, to: string): string => {
    const t = inside(root, to);
    return String(to).endsWith('/') || isDir(t) ? join(t, basename(from)) : t;
  };

  const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };

  /** 一批移动 / 复制的检查：源都在、目标都空着、不重名、不把文件夹放进它自己里面。 */
  const checkItems = (folder: string, items: readonly Item[]): Problem => {
    const bad = checkRoot(folder);
    if (bad) return bad;
    const root = canonical(folder);
    if (!Array.isArray(items) || items.length === 0) return { message: 'items 是空的', hint: '列出要处理的文件' };
    if (items.length > MAX_ITEMS) return { message: `一次最多 ${MAX_ITEMS} 项，这次 ${items.length} 项`, hint: '分几批做' };
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      try {
        const from = inside(root, it.from);
        if (!exists(from)) { problems.push(`没有 ${tilde(from)}`); continue; }
        const to = target(root, from, it.to);
        if (to === from) { problems.push(`${it.from} 移到原处`); continue; }
        if (within(to, from)) { problems.push(`不能把 ${it.from} 放进它自己里面`); continue; }
        if (exists(to)) { problems.push(`${tilde(to)} 已经有了（不覆盖）`); continue; }
        if (seen.has(to)) { problems.push(`有两项都要放到 ${tilde(to)}`); continue; }
        seen.add(to);
      } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
    }
    if (problems.length === 0) return null;
    return {
      message: `有 ${problems.length} 项不行：${problems.slice(0, 8).join('；')}${problems.length > 8 ? '…' : ''}`,
      hint: '已存在的换个名字（如加 (2)），不存在的先用 files.list 确认准确的名字；改好后整批重新调用',
    };
  };

  /** 建好目标的上级文件夹，新建的记下来（撤销时删掉空的）。 */
  const ensureParent = (root: string, p: string, changes: FileChange[]): void => {
    const missing: string[] = [];
    for (let d = dirname(p); d !== root && within(d, root) && !exists(d); d = dirname(d)) missing.unshift(d);
    for (const d of missing) { mkdirSync(d); changes.push({ op: 'mkdir', path: d }); }
  };

  /** 一批做完：说清楚做了几项、哪些没成（做到一半出错不回滚，已做的照样记下，能撤销）。 */
  const report = (verb: string, root: string, done: string[], failed: string[], changes: FileChange[]): ToolOutput => {
    if (done.length === 0) throw new ToolError('UPSTREAM', `一项也没${verb}成：${failed.slice(0, 5).join('；')}`, { retriable: false });
    const list = done.slice(0, 30).join('\n');
    const more = done.length > 30 ? `\n…还有 ${done.length - 30} 项` : '';
    const fails = failed.length ? `\n没成的 ${failed.length} 项：${failed.slice(0, 10).join('；')}` : '';
    return { summary: `在 ${tilde(root)} 里${verb}了 ${done.length} 项：\n${list}${more}${fails}`, changes };
  };

  const common = {
    risk: 'external' as const,
    triggers: [],
    grantBy: {
      key: FILES_ORGANIZE_GRANT_KEY,
      scope: (args: unknown) => folderScope(String((args as { folder?: unknown })?.folder ?? '')),
      covers: folderCovers,
    },
  };
  /** 完整的 JSON Schema（简写写不了「对象的数组」）。 */
  const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const folderField = { type: 'string' as const, description: '要整理的文件夹，用 ~ 开头的写法，如 ~/Downloads。下面的路径都相对它' };
  const itemsField = {
    type: 'array' as const, minItems: 1, maxItems: MAX_ITEMS,
    items: {
      type: 'object' as const, required: ['from', 'to'], additionalProperties: false,
      properties: {
        from: { type: 'string', description: '相对文件夹的路径，如 合同.pdf' },
        to: { type: 'string', description: '新位置。以 / 结尾表示放进这个文件夹（如 PDF/）；否则是新的路径和名字（如 PDF/合同-2026.pdf）' },
      },
    },
  };

  const mkdir = defineTool<{ folder: string; paths: string[] }>({
    ...common,
    id: 'files.mkdir',
    description: '在本机文件夹里新建子文件夹（可以多级、一次多个）。已经有的就跳过。',
    input: schema({
      folder: folderField,
      paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: '新文件夹的路径，相对 folder，如 ["PDF", "图片/2026"]' },
    }),
    precheck: async (a) => {
      const bad = checkRoot(a.folder);
      if (bad) return bad;
      try { for (const p of a.paths) { const f = inside(canonical(a.folder), p); if (exists(f) && !isDir(f)) return { message: `${tilde(f)} 是文件，不能建同名文件夹`, hint: '换个名字' }; } } catch (e) {
        return { message: e instanceof Error ? e.message : String(e) };
      }
      return null;
    },
    run: async ({ folder, paths }) => {
      const root = canonical(folder);
      const changes: FileChange[] = [];
      const done: string[] = [];
      for (const p of paths) {
        const full = inside(root, p);
        if (isDir(full)) continue;
        ensureParent(root, join(full, 'x'), changes);
        done.push(`${tilde(full)}/`);
      }
      if (done.length === 0) return { summary: '这些文件夹都已经有了' };
      return { summary: `新建了 ${done.length} 个文件夹：${done.join('、')}`, changes };
    },
  });

  const move = defineTool<{ folder: string; items: Item[] }>({
    ...common,
    id: 'files.move',
    description: '在本机文件夹里移动或重命名文件 / 文件夹（一次可以一批）。重命名就是同一位置换个名字。目标已有同名的不会覆盖；缺的上级文件夹会自动建。'
      + '整理文件时先用 files.list / files.find 看清楚有什么，再一次性把整批交给它。',
    input: schema({ folder: folderField, items: itemsField }),
    precheck: async (a) => checkItems(a.folder, a.items),
    run: async ({ folder, items }) => {
      const root = canonical(folder);
      const changes: FileChange[] = [];
      const done: string[] = [];
      const failed: string[] = [];
      for (const it of items) {
        try {
          const from = inside(root, it.from);
          const to = target(root, from, it.to);
          // 再查一次：rename 会静默覆盖已有的文件
          if (exists(to)) throw new Error(`${tilde(to)} 已经有了`);
          ensureParent(root, to, changes);
          try { renameSync(from, to); } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
            // 跨磁盘：先复制、再删原件（与 mv 一样）
            cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
            rmSync(from, { recursive: true });
          }
          changes.push({ op: 'move', from, path: to, ...stamp(to) });
          done.push(`${tilde(from).slice(tilde(root).length + 1)} → ${tilde(to).slice(tilde(root).length + 1)}`);
        } catch (e) { failed.push(`${it.from}（${e instanceof Error ? e.message : String(e)}）`); }
      }
      return report('移动', root, done, failed, changes);
    },
  });

  const copy = defineTool<{ folder: string; items: Item[] }>({
    ...common,
    id: 'files.copy',
    description: '在本机文件夹里复制文件 / 文件夹（一次可以一批）。目标已有同名的不会覆盖；缺的上级文件夹会自动建。',
    input: schema({ folder: folderField, items: itemsField }),
    precheck: async (a) => checkItems(a.folder, a.items),
    run: async ({ folder, items }) => {
      const root = canonical(folder);
      const changes: FileChange[] = [];
      const done: string[] = [];
      const failed: string[] = [];
      for (const it of items) {
        try {
          const from = inside(root, it.from);
          const to = target(root, from, it.to);
          ensureParent(root, to, changes);
          cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
          changes.push({ op: 'copy', from, path: to, ...stamp(to) });
          done.push(`${tilde(from).slice(tilde(root).length + 1)} → ${tilde(to).slice(tilde(root).length + 1)}`);
        } catch (e) { failed.push(`${it.from}（${e instanceof Error ? e.message : String(e)}）`); }
      }
      return report('复制', root, done, failed, changes);
    },
  });

  const write = defineTool<{ folder: string; name: string; content: string }>({
    ...common,
    id: 'files.write',
    description: '在本机文件夹里新建一个文本文件（.md / .txt / .csv / .json / .html）。不覆盖已有的文件。'
      + '只在用户要求把文件放进他的某个文件夹时用；只是要一份文件的，用 output.write。',
    input: schema({
      folder: folderField,
      name: { type: 'string', description: '文件路径，相对 folder，带扩展名，如 清单/九月.csv' },
      content: { type: 'string', description: '文件的完整内容' },
    }),
    precheck: async (a) => {
      const bad = checkRoot(a.folder);
      if (bad) return bad;
      if (!WRITE_EXTS.has(extname(String(a.name ?? '')).toLowerCase())) return { message: `不能新建这种文件：${a.name}`, hint: `用这些扩展名之一：${[...WRITE_EXTS].join(' ')}` };
      try {
        const full = inside(canonical(a.folder), a.name);
        if (exists(full)) return { message: `${tilde(full)} 已经有了（不覆盖）`, hint: '换个名字' };
      } catch (e) { return { message: e instanceof Error ? e.message : String(e) }; }
      return null;
    },
    run: async ({ folder, name, content }) => {
      const root = canonical(folder);
      const full = inside(root, name);
      const changes: FileChange[] = [];
      ensureParent(root, full, changes);
      const csv = extname(full).toLowerCase() === '.csv';
      // 'wx'：已存在就失败，不覆盖。CSV 加 BOM：Excel 直接打开中文不乱码
      writeFileSync(full, csv && !content.startsWith('﻿') ? `﻿${content}` : content, { encoding: 'utf8', flag: 'wx' });
      const st = stamp(full);
      changes.push({ op: 'write', path: full, ...st });
      return { summary: `新建了 ${tilde(full)}（${st.size} 字节）`, changes, files: [{ name: basename(full), path: full, size: st.size }] };
    },
  });

  const tools: Tool[] = [mkdir, move, copy, write];
  if (opts.trash) {
    const trashFn = opts.trash;
    tools.push(defineTool<{ folder: string; paths: string[] }>({
      ...common,
      // 删除每次都问：不进「始终允许」（不可撤销类不能授权）。虽然能从废纸篓放回，但 Agent 删错的代价不对称
      risk: 'irreversible',
      id: 'files.trash',
      description: '把本机文件夹里的文件 / 文件夹移到废纸篓（一次可以一批）。不会彻底删除，用户可以从废纸篓放回。每次都会请用户确认。',
      input: schema({
        folder: folderField,
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_ITEMS, description: '要删的路径，相对 folder' },
      }),
      precheck: async (a) => {
        const bad = checkRoot(a.folder);
        if (bad) return bad;
        const missing: string[] = [];
        try { for (const p of a.paths) { const f = inside(canonical(a.folder), p); if (!exists(f)) missing.push(p); } } catch (e) {
          return { message: e instanceof Error ? e.message : String(e) };
        }
        return missing.length ? { message: `没有这些：${missing.slice(0, 8).join('、')}`, hint: '先用 files.list 确认准确的名字' } : null;
      },
      run: async ({ folder, paths }) => {
        const root = canonical(folder);
        const changes: FileChange[] = [];
        const done: string[] = [];
        const failed: string[] = [];
        for (const p of paths) {
          try {
            const full = inside(root, p);
            await trashFn(full);
            changes.push({ op: 'trash', path: full, from: full });
            done.push(tilde(full).slice(tilde(root).length + 1));
          } catch (e) { failed.push(`${p}（${e instanceof Error ? e.message : String(e)}）`); }
        }
        return report('移到废纸篓', root, done, failed, changes);
      },
    }));
  }
  return tools;
}

// ── 撤销 ──────────────────────────────────────────────────────────

/** 现在的样子还是改动后的样子吗（没被别的程序动过）。文件夹只看在不在：往里放东西会改它的修改时间。 */
function unchanged(c: FileChange): boolean {
  let st;
  try { st = lstatSync(c.path); } catch { return false; }
  if (st.isDirectory()) return true;
  return (c.size === undefined || st.size === c.size) && (c.mtime === undefined || Math.abs(Math.round(st.mtimeMs) - c.mtime) < 2);
}

/** 文件夹是空的（访达自己放的 .DS_Store 不算）。 */
const emptyDir = (p: string): boolean => { try { return readdirSync(p).every((n) => n === '.DS_Store'); } catch { return false; } };

export type UndoState =
  /** 能撤销：改过的都还是改完时的样子。 */
  | { readonly state: 'undoable' }
  /** 已经撤销过（或用户自己改回去了）。 */
  | { readonly state: 'undone' }
  /** 撤销不了：之后又被改过、原位置被占了…… */
  | { readonly state: 'conflict'; readonly reason: string }
  /** 没有能撤销的（只有移到废纸篓的：从废纸篓放回）。 */
  | { readonly state: 'none' };

const reversible = (cs: readonly FileChange[]): FileChange[] => cs.filter((c) => c.op !== 'trash');

/** 一次调用的改动现在能不能撤销。宿主每次画卡片时问一遍，不用自己记「撤销过没有」。 */
export function undoState(changes: readonly FileChange[]): UndoState {
  const cs = reversible(changes);
  if (cs.length === 0) return { state: 'none' };
  const gone = (c: FileChange): boolean => !existsSync(c.path) && (c.op !== 'move' || existsSync(c.from!));
  if (cs.every(gone)) return { state: 'undone' };
  for (const c of cs) {
    if (c.op === 'mkdir') continue;
    if (!unchanged(c)) return { state: 'conflict', reason: `${tilde(c.path)} 之后又被改过或挪走了` };
    if (c.op === 'move' && existsSync(c.from!)) return { state: 'conflict', reason: `原来的位置 ${tilde(c.from!)} 现在有别的文件` };
  }
  return { state: 'undoable' };
}

export interface UndoResult {
  readonly undone: number;
  readonly skipped: readonly { readonly path: string; readonly why: string }[];
}

/**
 * 撤销一次调用的改动，按相反的顺序：移回去、删掉复制出来的和新建的（走废纸篓，宿主给了的话）、删掉新建的空文件夹。
 * 之后被别的程序改过的不动（跳过并说明）—— 撤销不能毁掉用户后来的工作。移到废纸篓的不在这里撤（从废纸篓放回）。
 * 受保护的位置不动（`prot`，与工具同一份）。
 */
export async function undoChanges(
  changes: readonly FileChange[],
  opts: { readonly trash?: (path: string) => Promise<void>; readonly prot?: readonly string[] } = {},
): Promise<UndoResult> {
  let undone = 0;
  const skipped: { path: string; why: string }[] = [];
  const prot = opts.prot ?? [];
  for (const c of [...changes].reverse()) {
    const p = tilde(c.path);
    if (c.op === 'trash') { skipped.push({ path: p, why: '在废纸篓里，可以在访达里「放回原处」' }); continue; }
    if (isProtected(c.path, prot) || (c.from && isProtected(c.from, prot))) { skipped.push({ path: p, why: '受保护的位置' }); continue; }
    if (!existsSync(c.path)) continue;
    try {
      if (c.op === 'mkdir') {
        if (!emptyDir(c.path)) { skipped.push({ path: p, why: '文件夹里还有东西' }); continue; }
        rmSync(c.path, { recursive: true });
      } else if (!unchanged(c)) {
        skipped.push({ path: p, why: '之后又被改过' });
        continue;
      } else if (c.op === 'move') {
        if (existsSync(c.from!)) { skipped.push({ path: p, why: `原来的位置 ${tilde(c.from!)} 现在有别的文件` }); continue; }
        mkdirSync(dirname(c.from!), { recursive: true });
        renameSync(c.path, c.from!);
      } else if (opts.trash) {
        await opts.trash(c.path);
      } else {
        rmSync(c.path, { recursive: true });
      }
      undone += 1;
    } catch (e) { skipped.push({ path: p, why: e instanceof Error ? e.message : String(e) }); }
  }
  return { undone, skipped };
}
