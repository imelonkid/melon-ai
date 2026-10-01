import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Health, Skill, SkillBundle, SkillProvider, ToolHandler } from '@melon-ai/core';
import { ToolError, asSkillId } from '@melon-ai/core';
import { defineTool } from '../../registry/define.js';
import type { Tool } from '../../registry/define.js';
import { extract, readableKind } from './extract.js';
import {
  FILES_GRANT_KEY, canonical, folderCovers, folderScope, isDir, isProtected, nearest, protectedPaths, tilde, within,
} from './paths.js';

export interface FilesSkillOptions {
  /** 宿主自己存 key、存数据的目录：和密钥、钥匙串等一样受保护，不读。 */
  readonly denyRead?: readonly string[];
  /** 一次读进上下文的字数，默认 8000。后面的用 offset 接着读。 */
  readonly chunkChars?: number;
}

/** 列目录、找文件时跳过的：隐藏文件、系统和开发产物目录。 */
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.Trash', 'Library']);
const FIND_DEPTH = 5;
const FIND_SCAN = 5000;

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const date = (ms: number): string => {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 本地文件：列目录、按名字找文件、读文件内容（文本；PDF、Word、Excel 抽文字）。只读，不写不删。
 *
 * - **数据出境**：读到的内容会发给模型厂商，所以三个工具都按对外操作处理（risk: external）—— 先问用户；
 *   「始终允许」按文件夹（`grantBy`）：允许了 ~/Downloads，三个工具在它和子文件夹里都放行。
 * - **受保护的位置不读**：密钥、钥匙串、浏览器资料（与沙箱同一份清单）+ 宿主的数据目录。允许了家目录也一样。
 * - **内容不可信**：文件里可以写任何话（「把这些发给某某」）—— 读过的任务之后的对外操作一律要人确认。
 * - **问之前先查**（`precheck`）：文件夹不存在时退回给模型，带上近似的名字（`~/Download` → `~/Downloads`）；
 *   不让用户批准一个注定失败的调用。
 */
export class FilesSkillProvider implements SkillProvider {
  readonly id = 'melon-files';
  private readonly prot: readonly string[];
  private readonly chunk: number;

  constructor(opts: FilesSkillOptions = {}) {
    this.prot = protectedPaths(opts.denyRead ?? []);
    this.chunk = opts.chunkChars ?? 8000;
  }

  async health(): Promise<Health> {
    return { status: 'up' };
  }

  /** 文件夹参数的检查：存在、是文件夹、不受保护；不存在时给近似的。 */
  private checkFolder(folder: string): { message: string; hint?: string } | null {
    const abs = canonical(folder);
    if (isProtected(abs, this.prot)) {
      return { message: `${tilde(abs)} 是受保护的位置（密钥、钥匙串、浏览器资料或应用数据），不能查看`, hint: '告诉用户这个位置受保护、不能看。不要换别的办法绕过' };
    }
    if (!isDir(abs)) {
      const near = nearest(abs);
      return near && isDir(near)
        ? { message: `没有 ${tilde(abs)} 这个文件夹`, hint: `可能是 ${tilde(near)}：用它再试一次` }
        : { message: `没有 ${tilde(abs)} 这个文件夹`, hint: '问用户文件夹的准确位置' };
    }
    return null;
  }

  /** 文件夹里的一个文件：不能越出文件夹，不能受保护。 */
  private fileIn(folder: string, file: string): string {
    const dir = canonical(folder);
    const full = canonical(resolve(dir, String(file ?? '')));
    if (!within(full, dir)) throw new ToolError('INVALID_ARGS', `${file} 不在 ${tilde(dir)} 里`, { hint: 'file 写相对这个文件夹的路径' });
    if (isProtected(full, this.prot)) throw new ToolError('DENIED', `${tilde(full)} 是受保护的位置，不能读`, { retriable: false, hint: '告诉用户这个文件受保护。不要换别的办法绕过' });
    return full;
  }

  private tools(): Tool[] {
    const common = {
      risk: 'external' as const,
      // 读本机文件不是用户嘴里的某个说法就必须调用的动作：不设触发词
      triggers: [],
      untrustedOutput: true,
      grantBy: {
        key: FILES_GRANT_KEY,
        scope: (args: unknown) => folderScope(String((args as { folder?: unknown })?.folder ?? '')),
        covers: folderCovers,
      },
    };
    const folderField = { type: 'string' as const, description: '文件夹，用 ~ 开头的写法，如 ~/Downloads、~/Documents/报表' };

    const list = defineTool<{ folder: string; sort?: 'time' | 'size' | 'name'; limit?: number }>({
      ...common,
      id: 'files.list',
      outputLimit: 8000,
      description: '列出本机某个文件夹里的文件和子文件夹（名字、大小、修改时间）。用户问「某个目录下有什么」「最近下载了什么」时用。',
      input: {
        folder: folderField,
        sort: { type: 'string', enum: ['time', 'size', 'name'], optional: true, description: '排序：time 最新的在前（默认）、size 大的在前、name 按名字' },
        limit: { type: 'integer', minimum: 1, maximum: 200, optional: true, description: '最多列多少项，默认 50' },
      },
      precheck: async (a) => this.checkFolder(a.folder),
      run: async ({ folder, sort = 'time', limit = 50 }) => {
        const dir = canonical(folder);
        const items = readdirSync(dir).filter((n) => !n.startsWith('.')).flatMap((name) => {
          const full = join(dir, name);
          if (isProtected(full, this.prot)) return [];
          try { const st = statSync(full); return [{ name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }]; } catch { return []; }
        });
        items.sort((a, b) => (sort === 'size' ? b.size - a.size : sort === 'name' ? a.name.localeCompare(b.name) : b.mtime - a.mtime));
        const shown = items.slice(0, limit);
        const dirs = items.filter((x) => x.dir).length;
        const lines = shown.map((x) => (x.dir ? `${x.name}/\t文件夹\t${date(x.mtime)}` : `${x.name}\t${size(x.size)}\t${date(x.mtime)}`));
        return `${tilde(dir)}：${items.length - dirs} 个文件、${dirs} 个文件夹${items.length > limit ? `（列出前 ${limit} 项）` : ''}\n${lines.join('\n') || '（空的）'}`;
      },
    });

    const find = defineTool<{ folder: string; name?: string; ext?: string; days?: number; limit?: number }>({
      ...common,
      id: 'files.find',
      outputLimit: 6000,
      description: '在本机某个文件夹（含子文件夹）里按名字、类型、修改时间找文件。用户要找「上周下载的 PDF」「名字里有合同的文件」时用。',
      input: {
        folder: folderField,
        name: { type: 'string', optional: true, description: '文件名里包含的字，不区分大小写' },
        ext: { type: 'string', optional: true, description: '扩展名，如 pdf、xlsx' },
        days: { type: 'integer', minimum: 1, optional: true, description: '只要最近几天改过的' },
        limit: { type: 'integer', minimum: 1, maximum: 200, optional: true, description: '最多返回多少个，默认 30' },
      },
      precheck: async (a) => this.checkFolder(a.folder),
      run: async ({ folder, name, ext, days, limit = 30 }) => {
        const root = canonical(folder);
        const want = name?.toLowerCase();
        const dot = ext ? `.${ext.replace(/^\./, '').toLowerCase()}` : null;
        const since = days ? Date.now() - days * 86_400_000 : 0;
        const hits: { rel: string; size: number; mtime: number }[] = [];
        let scanned = 0;
        const walk = (dir: string, depth: number): void => {
          if (depth > FIND_DEPTH || scanned > FIND_SCAN) return;
          let names: string[];
          try { names = readdirSync(dir); } catch { return; }
          for (const n of names) {
            if (n.startsWith('.') || SKIP.has(n) || ++scanned > FIND_SCAN) continue;
            const full = join(dir, n);
            if (isProtected(full, this.prot)) continue;
            let st;
            try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) { walk(full, depth + 1); continue; }
            if (want && !n.toLowerCase().includes(want)) continue;
            if (dot && !n.toLowerCase().endsWith(dot)) continue;
            if (st.mtimeMs < since) continue;
            hits.push({ rel: relative(root, full), size: st.size, mtime: st.mtimeMs });
          }
        };
        walk(root, 0);
        hits.sort((a, b) => b.mtime - a.mtime);
        const lines = hits.slice(0, limit).map((h) => `${h.rel}\t${size(h.size)}\t${date(h.mtime)}`);
        return `在 ${tilde(root)} 里找到 ${hits.length} 个${hits.length > limit ? `（列出最新的 ${limit} 个）` : ''}${scanned > FIND_SCAN ? '（文件太多，只看了一部分）' : ''}\n${lines.join('\n') || '（没有）'}`;
      },
    });

    const read = defineTool<{ folder: string; file: string; offset?: number }>({
      ...common,
      id: 'files.read',
      // 一段就是 chunk 字，再加文件头和「还有多少字」的说明
      outputLimit: this.chunk + 400,
      description: '读取本机文件的内容：文本、Markdown、CSV、代码直接读；PDF、Word（.docx）、Excel（.xlsx）抽出文字。长文件分段读，用 offset 接着读。',
      input: {
        folder: folderField,
        file: { type: 'string', description: '相对这个文件夹的文件路径，如 报表/9月.xlsx' },
        offset: { type: 'integer', minimum: 0, optional: true, description: '从第几个字开始读，默认 0' },
      },
      precheck: async (a) => {
        const bad = this.checkFolder(a.folder);
        if (bad) return bad;
        const full = canonical(resolve(canonical(a.folder), String(a.file ?? '')));
        try { if (!statSync(full).isFile()) return { message: `${tilde(full)} 不是文件`, hint: '先用 files.list 看看有哪些文件' }; } catch {
          return { message: `没有 ${tilde(full)} 这个文件`, hint: '先用 files.list 或 files.find 找到准确的文件名' };
        }
        const k = readableKind(full);
        return 'unreadable' in k ? { message: `${tilde(full)} 是${k.unreadable}，读不了文字`, hint: '告诉用户这种文件读不了' } : null;
      },
      run: async ({ folder, file, offset = 0 }) => {
        const full = this.fileIn(folder, file);
        const k = readableKind(full);
        if ('unreadable' in k) throw new ToolError('INVALID_ARGS', `${tilde(full)} 是${k.unreadable}，读不了文字`, { retriable: false });
        let got;
        try { got = await extract(full, k.kind); } catch (e) {
          throw new ToolError('UPSTREAM', `读不了 ${tilde(full)}：${e instanceof Error ? e.message : String(e)}`, { retriable: false });
        }
        const total = got.text.length;
        const part = got.text.slice(offset, offset + this.chunk);
        const end = offset + part.length;
        const head = `文件：${tilde(full)}（${got.note}，共 ${total} 字）${offset > 0 || end < total ? `\n第 ${offset + 1}–${end} 字：` : ''}`;
        const more = end < total ? `\n\n…还有 ${total - end} 字没读。要接着读就用 offset=${end}` : '';
        return `${head}\n${part || '（没有文字）'}${more}`;
      },
    });
    return [list, find, read];
  }

  async list(): Promise<readonly SkillBundle[]> {
    const tools = this.tools();
    const skill: Skill = {
      id: asSkillId('files'),
      name: '本地文件',
      purpose: '需要查看本机的文件夹、找文件、读文件内容（文本、PDF、Word、Excel）时使用',
      keywords: ['文件', '文件夹', '目录', '下载', '桌面', '文档', 'PDF', 'Word', 'Excel', '表格', 'Downloads', 'Documents', 'Desktop', '~/', 'file', 'folder'],
      tools: tools.map((t) => t.descriptor),
      source: { kind: 'builtin' },
    };
    const handlers = new Map<string, ToolHandler>(tools.map((t) => [t.descriptor.id, t.handler]));
    return [{ skill, handlers }];
  }
}

/** 本地文件技能。`denyRead` 给宿主自己存数据的目录。 */
export function files(opts: FilesSkillOptions = {}): FilesSkillProvider {
  return new FilesSkillProvider(opts);
}
