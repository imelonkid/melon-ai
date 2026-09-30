import type { JSONSchema, SchemaValidator, ValidationIssue } from '@melon-ai/core';

/** JSON Schema 的类型名与 JS 的 typeof 不一一对应：array 的 typeof 是 object，integer 是 number。 */
const IS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: Array.isArray,
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};
const kindOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

type Spec = {
  type?: string;
  enum?: readonly unknown[];
  items?: Spec;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  description?: string;
  properties?: Record<string, Spec>;
  required?: readonly string[];
};

/**
 * 默认参数校验器：JSON Schema 里工具参数最常用的那一小部分 ——
 * `required` / `type`（含 array、integer）/ `enum` / `items` / `minimum` / `maximum` / `pattern`，
 * 嵌套对象递归。
 *
 * 引擎不内置 ajv（体积，§ports/tools 的说明），但宿主也不该为了跑起来先写一个校验器。
 * 需要完整 JSON Schema 时，宿主传自己的 `SchemaValidator` 即可。
 */
export const basicValidator: SchemaValidator = {
  validate(schema: JSONSchema, value: unknown): readonly ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    check(schema as Spec, value, '', issues);
    return issues;
  },
};

function check(spec: Spec, v: unknown, path: string, out: ValidationIssue[]): void {
  if (spec.type && IS[spec.type] && !IS[spec.type]!(v)) {
    out.push({ path: path || '/', message: `应为 ${spec.type}，收到 ${kindOf(v)}` });
    return;
  }
  if (spec.enum && !spec.enum.includes(v)) {
    out.push({ path: path || '/', message: `应为 ${spec.enum.join(' / ')} 之一` });
    return;
  }
  // pattern 不合格时把字段说明带上 —— 这条会回喂给模型，它得知道该怎么改（比如「收件人要写成邮箱地址」）
  if (typeof v === 'string' && spec.pattern && !new RegExp(spec.pattern, 'u').test(v)) {
    out.push({ path: path || '/', message: `格式不对${spec.description ? `（${spec.description}）` : ''}` });
    return;
  }
  if (typeof v === 'number') {
    if (spec.minimum !== undefined && v < spec.minimum) out.push({ path, message: `不能小于 ${spec.minimum}` });
    if (spec.maximum !== undefined && v > spec.maximum) out.push({ path, message: `不能大于 ${spec.maximum}` });
  }
  if (Array.isArray(v) && spec.items) {
    v.forEach((x, i) => check(spec.items!, x, `${path}/${i}`, out));
  }
  if (spec.properties || spec.required) {
    const obj = (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    for (const k of spec.required ?? []) {
      if (obj[k] === undefined) out.push({ path: `${path}/${k}`, message: '必填参数缺失' });
    }
    for (const [k, sub] of Object.entries(spec.properties ?? {})) {
      if (obj[k] !== undefined) check(sub, obj[k], `${path}/${k}`, out);
    }
  }
}
