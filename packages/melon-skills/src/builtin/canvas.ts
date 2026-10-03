import type {
  CanvasKind, CanvasStore, CanvasVersion, SchemaValidator, SkillBundle, SkillProvider, TaskId, ToolHandler,
} from '@melon-ai/core';
import { ToolError, asSkillId } from '@melon-ai/core';
import { defineTool } from '../registry/define.js';

/**
 * 内置技能「画布」：Agent 读、改当前对话绑定的那块画布（`task.canvas`）。
 *
 * - 改法是 JSON Patch 的一个子集（add / replace / remove / move），按 JSON Pointer 定位 —— 局部改，
 *   用户在界面上手改过的地方不会被整份重写盖掉。第一次生成用 `replace` 根（path 为空串）。
 * - 改完要符合这种画布的数据形状（宿主给的 JSON Schema），不符合就退回给模型改。
 * - 每次改追加一个版本（`by: 'agent'`），宿主据此刷新界面、可以撤销到任意版本。
 * 只在绑定了画布的任务里提供（`when`）。
 */
export interface CanvasOptions {
  readonly store: CanvasStore;
  readonly kinds: () => ReadonlyMap<string, CanvasKind>;
  readonly validator: SchemaValidator;
  readonly now: () => number;
  /** 这个任务绑定的画布。 */
  readonly canvasOf: (taskId: TaskId) => Promise<{ id: string; kind: string } | null>;
  /** 改出了新版本（宿主刷新界面）。 */
  readonly onChange?: (v: CanvasVersion) => void;
}

export interface PatchOp {
  readonly op: 'add' | 'replace' | 'remove' | 'move';
  readonly path: string;
  readonly value?: unknown;
  readonly from?: string;
}

/** 最多读进上下文这么多字；再大的只给开头，要看全文分段读。 */
const READ_MAX = 16_000;

const unescape = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');
const tokens = (path: string): string[] => {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new ToolError('INVALID_ARGS', `路径要以 / 开头：${path}`, { hint: '用 JSON Pointer，如 /messages/3/text' });
  return path.slice(1).split('/').map(unescape);
};

/** 按 JSON Patch 的子集改一份 JSON（不修改原对象）。路径不存在、下标越界抛 INVALID_ARGS。 */
export function applyPatch(doc: unknown, ops: readonly PatchOp[]): unknown {
  let root: unknown = structuredClone(doc ?? null);
  const parentOf = (path: string): { parent: Record<string, unknown> | unknown[]; key: string } => {
    const t = tokens(path);
    if (t.length === 0) throw new ToolError('INVALID_ARGS', '这个操作不能对整份内容做', { hint: '整份换掉用 replace，path 为空串' });
    let cur: unknown = root;
    for (const k of t.slice(0, -1)) {
      if (cur === null || typeof cur !== 'object') throw new ToolError('INVALID_ARGS', `路径不存在：${path}`, { hint: '先用 canvas.read 看清楚结构' });
      cur = Array.isArray(cur) ? cur[Number(k)] : (cur as Record<string, unknown>)[k];
    }
    if (cur === null || typeof cur !== 'object') throw new ToolError('INVALID_ARGS', `路径不存在：${path}`, { hint: '先用 canvas.read 看清楚结构' });
    return { parent: cur as Record<string, unknown> | unknown[], key: t[t.length - 1]! };
  };
  const take = (path: string): unknown => {
    const { parent, key } = parentOf(path);
    if (Array.isArray(parent)) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= parent.length) throw new ToolError('INVALID_ARGS', `下标越界：${path}（共 ${parent.length} 项）`);
      return parent.splice(i, 1)[0];
    }
    if (!(key in parent)) throw new ToolError('INVALID_ARGS', `没有这个字段：${path}`);
    const v = parent[key];
    delete parent[key];
    return v;
  };
  const put = (path: string, value: unknown, insert: boolean): void => {
    if (tokens(path).length === 0) { root = structuredClone(value); return; }
    const { parent, key } = parentOf(path);
    if (Array.isArray(parent)) {
      const i = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(i) || i < 0 || i > parent.length || (!insert && i >= parent.length)) throw new ToolError('INVALID_ARGS', `下标越界：${path}（共 ${parent.length} 项）`);
      if (insert) parent.splice(i, 0, structuredClone(value)); else parent[i] = structuredClone(value);
      return;
    }
    if (!insert && !(key in parent)) throw new ToolError('INVALID_ARGS', `没有这个字段：${path}`, { hint: '新增字段用 add' });
    parent[key] = structuredClone(value);
  };
  for (const o of ops) {
    if (o.op === 'add') put(o.path, o.value, true);
    else if (o.op === 'replace') put(o.path, o.value, false);
    else if (o.op === 'remove') take(o.path);
    else if (o.op === 'move') {
      if (typeof o.from !== 'string') throw new ToolError('INVALID_ARGS', 'move 要给 from');
      put(o.path, take(o.from), true);
    } else throw new ToolError('INVALID_ARGS', `不认识的操作：${String((o as { op?: unknown }).op)}`, { hint: '只能用 add / replace / remove / move' });
  }
  return root;
}

/** 两份 JSON 哪里不一样（给人看的路径，最多 20 条）。用户在界面上改了什么，没写说明时用它告诉模型。 */
export function diffPaths(a: unknown, b: unknown, base = '', out: string[] = []): string[] {
  if (out.length >= 20) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const obj = (x: unknown) => x !== null && typeof x === 'object';
  if (!obj(a) || !obj(b) || Array.isArray(a) !== Array.isArray(b) || base.split('/').length > 4) { out.push(base || '/'); return out; }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${base}/${k}`, out);
  return out;
}

export function canvas(opts: CanvasOptions): SkillProvider {
  const kindOf = (kind: string): CanvasKind => {
    const k = opts.kinds().get(kind);
    if (!k) throw new ToolError('FATAL', `不认识的画布类型：${kind}`, { retriable: false });
    return k;
  };
  const bound = async (taskId: TaskId) => {
    const c = await opts.canvasOf(taskId);
    if (!c) throw new ToolError('INVALID_ARGS', '这个对话没有画布', { retriable: false, hint: '直接用文字回答' });
    return c;
  };

  const read = defineTool<{ offset?: number }>({
    id: 'canvas.read',
    description: '读当前画布的完整内容（JSON）和版本号。改之前先读，按真实结构定位要改的地方（用户可能在界面上手改过）。',
    input: { offset: { type: 'integer', minimum: 0, optional: true, description: '从第几个字开始读（内容很长时分段读）' } },
    outputLimit: READ_MAX + 400,
    run: async ({ offset = 0 }, cx) => {
      const c = await bound(cx.taskId);
      const v = await opts.store.latest(c.id);
      if (!v) return `画布（${kindOf(c.kind).name}）还是空的。用 canvas.update 生成：op 为 replace、path 为空串、value 是完整内容。`;
      const text = JSON.stringify(v.doc, null, 1);
      const part = text.slice(offset, offset + READ_MAX);
      const more = offset + part.length < text.length ? `\n…还有 ${text.length - offset - part.length} 字，用 offset=${offset + part.length} 接着读` : '';
      return `画布（${kindOf(c.kind).name}）v${v.version}${v.by === 'user' ? '（最后一次是用户在界面上改的）' : ''}：\n${part}${more}`;
    },
  });

  const update = defineTool<{ ops: PatchOp[]; note: string }>({
    id: 'canvas.update',
    description: '改画布：一组 JSON Patch 操作（add / replace / remove / move，path 用 JSON Pointer，如 /messages/3/text；数组末尾追加用 /messages/-）。'
      + '第一次生成：[{ op: "replace", path: "", value: 完整内容 }]。只改要改的地方，不要整份重写（用户手改过的会被盖掉）。note 用一句话写这次改了什么。',
    risk: 'write',
    triggers: [],
    input: {
      type: 'object',
      properties: {
        ops: {
          type: 'array', minItems: 1, maxItems: 200,
          items: {
            type: 'object', required: ['op', 'path'], additionalProperties: false,
            properties: {
              op: { type: 'string', enum: ['add', 'replace', 'remove', 'move'] },
              path: { type: 'string' },
              value: { description: 'add / replace 的新值' },
              from: { type: 'string', description: 'move 的来源路径' },
            },
          },
        },
        note: { type: 'string', description: '这次改了什么（一句话，给用户看）' },
      },
      required: ['ops', 'note'],
      additionalProperties: false,
    },
    run: async ({ ops, note }, cx) => {
      const c = await bound(cx.taskId);
      const kind = kindOf(c.kind);
      const cur = await opts.store.latest(c.id);
      const doc = applyPatch(cur?.doc ?? null, ops);
      const issues = opts.validator.validate(kind.schema, doc);
      if (issues.length) {
        throw new ToolError('INVALID_ARGS', `改完不符合「${kind.name}」的格式：${issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('；')}`, { hint: '按画布的格式说明改好再提交（这次没有生效）' });
      }
      const v: CanvasVersion = { canvasId: c.id, kind: c.kind, version: (cur?.version ?? 0) + 1, doc, by: 'agent', at: opts.now(), taskId: String(cx.taskId), note: String(note ?? '').slice(0, 200) };
      await opts.store.append(v);
      opts.onChange?.(v);
      return `画布已更新到 v${v.version}：${v.note}。界面已经刷新，回答里不用再把内容复述一遍。`;
    },
  });

  return {
    id: 'melon-canvas',
    async health() { return { status: 'up' }; },
    async list(): Promise<readonly SkillBundle[]> {
      const tools = [read, update];
      const onlyWithCanvas = (task: { canvas?: unknown }) => !!task.canvas;
      return [{
        skill: {
          id: asSkillId('canvas'), name: '画布', purpose: '对话绑定了画布时：读、改画布上的内容', keywords: ['画布'],
          tools: tools.map((t) => t.descriptor), source: { kind: 'builtin' },
        },
        handlers: new Map<string, ToolHandler>(tools.map((t) => [String(t.descriptor.id), t.handler])),
        when: new Map(tools.map((t) => [String(t.descriptor.id), onlyWithCanvas])),
      }];
    },
  };
}
