import type {
  JSONSchema, ResolvedTool, SchemaValidator, ToolDescriptor, ToolHandler, ToolId,
  ToolResolver, ToolsetSnapshot, ValidationIssue,
} from '@melon-ai/core';

/**
 * 结构化校验器：只查 `required` 与顶层 `type`。
 *
 * **刻意不完整** —— 它的作用是验证管线的接线（校验失败要变成 INVALID_ARGS 回喂），
 * 不是替代 ajv。真实校验语义要用真适配器测。
 */
export class StructuralValidator implements SchemaValidator {
  validate(schema: JSONSchema, value: unknown): readonly ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const required = schema['required'];
    const props = schema['properties'] as Record<string, { type?: string }> | undefined;
    if (Array.isArray(required)) {
      const o = (value ?? {}) as Record<string, unknown>;
      for (const k of required) {
        if (typeof k === 'string' && o[k] === undefined) {
          issues.push({ path: `/${k}`, message: '必填参数缺失' });
        }
      }
    }
    if (props && value !== null && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      for (const [k, spec] of Object.entries(props)) {
        if (o[k] !== undefined && spec.type === 'string' && typeof o[k] !== 'string') {
          issues.push({ path: `/${k}`, message: '应为 string' });
        }
      }
    }
    return issues;
  }
}

export interface FakeToolSpec {
  readonly descriptor: ToolDescriptor;
  readonly handler: ToolHandler;
  readonly enabled?: boolean;
}

/** 静态工具解析器。按 toolId 查表，并可单独关掉某个工具以测准入第一道闸。 */
export class StaticToolResolver implements ToolResolver {
  private readonly tools = new Map<string, FakeToolSpec>();
  readonly resolveCalls: string[] = [];

  add(spec: FakeToolSpec): this {
    this.tools.set(spec.descriptor.id, spec);
    return this;
  }
  async resolve(toolId: ToolId, _snapshot: ToolsetSnapshot): Promise<ResolvedTool | null> {
    this.resolveCalls.push(toolId);
    const t = this.tools.get(toolId);
    return t ? { descriptor: t.descriptor, handler: t.handler } : null;
  }
  async isEnabledFor(toolId: ToolId): Promise<boolean> {
    return this.tools.get(toolId)?.enabled ?? true;
  }
}
