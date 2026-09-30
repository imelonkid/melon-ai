import type {
  JSONSchema, RiskClass, SkillProvider, Task, ToolContext, ToolDescriptor, ToolHandler, ToolOutput,
} from '@melon-ai/core';
import { asSkillId, asToolId } from '@melon-ai/core';

/**
 * 参数的简写。宿主多数时候只想说「to 是字符串、body 可选」，不想手写 JSON Schema：
 *
 * ```ts
 * input: { to: 'string', subject: 'string', body: 'string?', days: 'integer[]' }
 * ```
 *
 * 每个字段也可以写成对象，带说明与枚举：`{ type: 'string', enum: [...], description, optional }`。
 * 传入的对象里有 `properties` 时，按完整 JSON Schema 原样使用。
 */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object';
export type FieldShorthand = `${FieldType}${'' | '[]'}${'' | '?'}`;
export interface FieldSpec {
  readonly type: FieldType | `${FieldType}[]`;
  readonly description?: string;
  readonly enum?: readonly (string | number)[];
  readonly minimum?: number;
  readonly maximum?: number;
  /** 字符串的正则（JSON Schema 的 pattern）。不合格的调用在**问用户之前**就被退回给模型。 */
  readonly pattern?: string;
  /** 值必须是用户自己说过的（收件人、金额……）。见 `ToolDescriptor.userSupplied`。 */
  readonly fromUser?: boolean;
  readonly optional?: boolean;
}
export type InputShape = Readonly<Record<string, FieldShorthand | FieldSpec>>;

export interface ToolSpec<A = Record<string, unknown>> {
  /** `<技能>.<名字>`，如 `mail.send`。点号前的部分是技能 id。 */
  readonly id: string;
  /** 「什么时候该用我」—— 模型选工具几乎全靠这一句。 */
  readonly description: string;
  /** 默认 `read`。对外、花钱、不可撤销的操作一定要写对，准入矩阵据此决定要不要问人。 */
  readonly risk?: RiskClass;
  readonly input?: InputShape | JSONSchema;
  /** 「始终允许」的授权范围看哪些参数。例：`mail.send` 写 `['to']`。 */
  readonly scope?: readonly string[];
  /** 默认：read 类幂等，其余不幂等（重放时由幂等层兜住）。 */
  readonly idempotent?: boolean;
  /** 输出来自外部、不可信（网页、第三方返回）。见 core 的 `ToolDescriptor.untrustedOutput`。 */
  readonly untrustedOutput?: boolean;
  /**
   * 触发词：用户的话里出现其中之一，引擎就认定要用这个工具（规则判定，不问模型）。
   * 有副作用的工具一定要写 —— 召回到了，模型就必须调用它，只回一段话不算数。
   */
  readonly triggers?: readonly string[];
  /** 结果摘要进上下文的上限（字符）。只有「结果就是给模型的指令」的工具需要调大。 */
  readonly outputLimit?: number;
  /** 只在满足条件的任务里提供给模型，例如「只在对话里」。 */
  readonly when?: (task: Task) => boolean;
  run(args: A, ctx: ToolContext): Promise<string | ToolOutput> | string | ToolOutput;
}

/** 一个可以交给引擎的工具：描述 + 处理函数（+ 可选的提供条件）。 */
export interface Tool {
  readonly descriptor: ToolDescriptor;
  readonly handler: ToolHandler;
  readonly when?: (task: Task) => boolean;
}

/**
 * 定义一个工具。
 *
 * ```ts
 * const mailSend = defineTool({
 *   id: 'mail.send', description: '以用户名义发送邮件', risk: 'external',
 *   input: { to: 'string', subject: 'string', body: 'string?' }, scope: ['to'],
 *   run: async ({ to, subject }) => `已将「${subject}」发送至 ${to}`,
 * });
 * ```
 *
 * `run` 返回字符串即 summary；要带 artifact 或结构化数据时返回 `ToolOutput`。
 */
export function defineTool<A = Record<string, unknown>>(spec: ToolSpec<A>): Tool {
  const dot = spec.id.indexOf('.');
  if (dot <= 0 || dot === spec.id.length - 1) {
    throw new Error(`工具 id 要写成「技能.名字」，如 mail.send：${spec.id}`);
  }
  const risk = spec.risk ?? 'read';
  const descriptor: ToolDescriptor = {
    id: asToolId(spec.id),
    skillId: asSkillId(spec.id.slice(0, dot)),
    name: spec.id.slice(dot + 1),
    description: spec.description,
    input: toSchema(spec.input ?? {}),
    risk,
    idempotent: spec.idempotent ?? risk === 'read',
    ...(spec.scope ? { scopeKeys: spec.scope } : {}),
    ...(spec.untrustedOutput ? { untrustedOutput: true } : {}),
    ...(spec.triggers?.length ? { triggers: spec.triggers } : {}),
    ...(spec.outputLimit ? { outputLimit: spec.outputLimit } : {}),
    ...(userSuppliedOf(spec.input) ? { userSupplied: userSuppliedOf(spec.input)! } : {}),
  };
  const handler: ToolHandler = async (args, ctx) => {
    const out = await spec.run(args as A, ctx);
    return typeof out === 'string' ? { summary: out } : out;
  };
  return spec.when ? { descriptor, handler, when: spec.when } : { descriptor, handler };
}

/** 简写里标了 fromUser 的参数名。 */
function userSuppliedOf(input: ToolSpec['input']): readonly string[] | null {
  if (!input || 'properties' in input) return null;
  const keys = Object.entries(input as InputShape).filter(([, f]) => typeof f === 'object' && f.fromUser).map(([k]) => k);
  return keys.length > 0 ? keys : null;
}

/** 简写 → JSON Schema。已经是 JSON Schema（有 properties）的原样返回。 */
export function toSchema(input: InputShape | JSONSchema): JSONSchema {
  if ('properties' in input || 'type' in input && input['type'] === 'object') return input as JSONSchema;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, raw] of Object.entries(input as InputShape)) {
    const f: FieldSpec = typeof raw === 'string'
      ? { type: raw.replace('?', '') as FieldSpec['type'], optional: raw.endsWith('?') }
      : raw;
    const isArray = f.type.endsWith('[]');
    const base = isArray ? f.type.slice(0, -2) : f.type;
    const item: Record<string, unknown> = {
      type: base,
      ...(f.enum ? { enum: f.enum } : {}),
      ...(f.minimum !== undefined ? { minimum: f.minimum } : {}),
      ...(f.maximum !== undefined ? { maximum: f.maximum } : {}),
      ...(f.pattern ? { pattern: f.pattern } : {}),
    };
    properties[key] = {
      ...(isArray ? { type: 'array', items: item } : item),
      ...(f.description ? { description: f.description } : {}),
    };
    if (!f.optional) required.push(key);
  }
  return { type: 'object', properties, required };
}

export interface SkillSpec {
  /** 技能 id，与其工具 id 的前缀一致，如 `mail`。 */
  readonly id: string;
  readonly name: string;
  /** 「什么时候该用我」。 */
  readonly purpose: string;
  readonly keywords?: readonly string[];
  readonly tools: readonly Tool[];
  /**
   * 引擎自带的技能标 true。注册表据此定先后：内置的不能被宿主或用户装的技能覆盖。
   * 宿主自己的代码可以用；用户装的技能由加载器创建，永远不是内置。
   */
  readonly builtin?: boolean;
}

/** 把一组工具打包成一个技能来源（`SkillProvider`），交给 `createAgent({ skills })`。 */
export function defineSkill(spec: SkillSpec): SkillProvider {
  const skillId = asSkillId(spec.id);
  const bundle = {
    skill: {
      id: skillId,
      name: spec.name,
      purpose: spec.purpose,
      keywords: spec.keywords ?? [],
      tools: spec.tools.map((t) => t.descriptor),
      source: spec.builtin ? { kind: 'builtin' as const } : { kind: 'extension' as const, providerId: spec.id, version: '1' },
    },
    handlers: new Map(spec.tools.map((t) => [String(t.descriptor.id), t.handler])),
    when: new Map(spec.tools.flatMap((t) => (t.when ? [[String(t.descriptor.id), t.when] as const] : []))),
  };
  return {
    id: `skill:${spec.id}`,
    list: async () => [bundle],
    health: async () => ({ status: 'up' }),
  };
}
