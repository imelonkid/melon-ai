import type {
  AgentId, ArtifactMeta, ArtifactRef, ArtifactStore, Grant, GrantStore, IdempotencyStore,
  JSONSchema, ResolvedTool, SchemaValidator, TaskId, ToolDescriptor, ToolHandler, ToolId,
  ToolResult, ToolResolver, ToolsetSnapshot, ValidationIssue,
} from '@melon-ai/core';
import { asArtifactRef } from '@melon-ai/core';

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly rows = new Map<string, { meta: ArtifactMeta; data: Uint8Array }>();
  private n = 0;
  constructor(private readonly now: () => number = () => 0) {}

  async put(taskId: TaskId, data: Uint8Array | string, meta: { mime: string; summary: string }): Promise<ArtifactRef> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ref = asArtifactRef(`art-${++this.n}`);
    this.rows.set(ref, {
      data: bytes,
      meta: { ref, taskId, mime: meta.mime, bytes: bytes.byteLength, summary: meta.summary, createdAt: this.now() },
    });
    return ref;
  }
  async read(ref: ArtifactRef, range?: { offset: number; length: number }): Promise<Uint8Array> {
    const row = this.rows.get(ref);
    if (!row) throw new Error(`no artifact ${ref}`);
    return range ? row.data.slice(range.offset, range.offset + range.length) : row.data;
  }
  async stat(ref: ArtifactRef): Promise<ArtifactMeta | null> {
    return this.rows.get(ref)?.meta ?? null;
  }
  async listByTask(taskId: TaskId): Promise<readonly ArtifactMeta[]> {
    return [...this.rows.values()].filter((r) => r.meta.taskId === taskId).map((r) => r.meta);
  }
  text(ref: ArtifactRef): string {
    return new TextDecoder().decode(this.rows.get(ref)!.data);
  }
  get size(): number { return this.rows.size; }
}

export class InMemoryGrantStore implements GrantStore {
  readonly rows: Grant[] = [];
  private key(agentId: string, toolId: string, scope: string): string {
    return `${agentId}|${toolId}|${scope}`;
  }
  async find(agentId: AgentId, toolId: string, scope: string): Promise<Grant | null> {
    return this.rows.find((g) => this.key(g.agentId, g.toolId, g.scope) === this.key(agentId, toolId, scope)) ?? null;
  }
  async put(grant: Grant): Promise<void> {
    await this.revoke(grant.agentId, grant.toolId, grant.scope);
    this.rows.push(grant);
  }
  async revoke(agentId: AgentId, toolId: string, scope?: string): Promise<void> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const g = this.rows[i]!;
      if (g.agentId === agentId && g.toolId === toolId && (scope === undefined || g.scope === scope)) {
        this.rows.splice(i, 1);
      }
    }
  }
  async listByAgent(agentId: AgentId): Promise<readonly Grant[]> {
    return this.rows.filter((g) => g.agentId === agentId);
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, ToolResult>();
  readonly hits: string[] = [];
  async get(key: string): Promise<ToolResult | null> {
    const hit = this.rows.get(key);
    if (hit) this.hits.push(key);
    return hit ?? null;
  }
  async put(key: string, result: ToolResult): Promise<void> {
    this.rows.set(key, result);
  }
}

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
