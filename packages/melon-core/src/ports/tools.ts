import type { JSONSchema, ToolDescriptor, ToolHandler, ToolResult } from '../tool.js';
import type { ToolId } from '../ids.js';
import type { ToolsetSnapshot } from '../skill.js';

/**
 * 工具解析。
 *
 * `melon-tools` 只认识这个端口，不认识技能注册表 —— 所以管线不依赖 `melon-skills`，
 * 两者在这里相遇。
 *
 * **必须按任务的 toolset 快照解析**：任务执行期间 MCP server 可能更新，
 * 若不按快照解析，同一个 `toolId` 在不同时刻含义不同，事件日志就不可重放。
 */
export interface ToolResolver {
  resolve(toolId: ToolId, snapshot: ToolsetSnapshot): Promise<ResolvedTool | null>;
  /** 该 skill 是否对这个 agent 开启（准入第一道闸的输入）。 */
  isEnabledFor(toolId: ToolId, agentId: string): Promise<boolean>;
}

export interface ResolvedTool {
  readonly descriptor: ToolDescriptor;
  readonly handler: ToolHandler;
}

export interface ValidationIssue {
  /** JSON Pointer，如 `/to/0`。 */
  readonly path: string;
  readonly message: string;
}

/**
 * 参数校验。
 *
 * 做成端口而不是在 `melon-tools` 里内置 ajv：宿主往往已经有校验器，
 * 而 Electron 里多打一个 ajv 进包是实打实的体积。
 * 契约层不绑定任何实现，换 zod / typebox 只是换一个适配器。
 */
export interface SchemaValidator {
  validate(schema: JSONSchema, value: unknown): readonly ValidationIssue[];
}

/**
 * 幂等短路。
 *
 * 非幂等工具在准入阶段分配 `idempotencyKey`；重放（崩溃恢复、effect 重跑）时
 * 命中已完成的结果就直接返回，不再真正执行 ——
 * §2.3 要求所有 Effect 幂等，而「发邮件」本身不幂等，靠这一层补齐。
 */
export interface IdempotencyStore {
  get(key: string): Promise<ToolResult | null>;
  put(key: string, result: ToolResult, ttlMs: number): Promise<void>;
}
