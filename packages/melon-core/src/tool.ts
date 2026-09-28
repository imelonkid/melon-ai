import type { ArtifactRef, CallId, SkillId, TaskId, ToolId } from './ids.js';
import type { ToolErrorShape } from './errors.js';
import type { LogField } from './ports/platform.js';
import type { TraceContext } from './trace.js';

/**
 * 风险等级。决定准入层要不要拦。顺序即严重程度。
 * - read          只读，不产生外部可见变化
 * - write         写内部状态（草稿、笔记）
 * - external      对外可见（发邮件、发消息、改共享文档）
 * - spend         花钱
 * - irreversible  不可撤销（删除、不可召回的发送）
 */
export type RiskClass = 'read' | 'write' | 'external' | 'spend' | 'irreversible';

export const RISK_ORDER: readonly RiskClass[] = ['read', 'write', 'external', 'spend', 'irreversible'];

/** JSON Schema 子集。故意不引 ajv 的类型 —— 契约层不绑定校验器实现。 */
export type JSONSchema = Record<string, unknown>;

/** 常驻上下文的工具签名（便宜）。全量 schema 按需通过 describe_tool 取（贵）。 */
export interface ToolSignature {
  readonly id: ToolId;
  readonly summary: string;
  readonly required: readonly string[];
  readonly risk: RiskClass;
}

export interface ToolDescriptor {
  readonly id: ToolId;
  readonly skillId: SkillId;
  readonly name: string;
  readonly description: string;
  readonly input: JSONSchema;
  readonly risk: RiskClass;
  /** 幂等工具可安全重试；非幂等工具由准入层分配 idempotencyKey。 */
  readonly idempotent: boolean;
  readonly costHint?: { readonly latencyMs: number; readonly bytesOut: number };
}

export interface ToolCall {
  readonly callId: CallId;
  readonly toolId: ToolId;
  readonly args: unknown;
  /** 对 args 归一化后的哈希。用于循环检测、幂等、以及「始终允许」的授权粒度。 */
  readonly argsHash: string;
}

/**
 * 工具执行期能看到的全部能力。**刻意收窄**：
 * 这里没有 SkillRegistry、没有任何 Store 引用，所以工具实现无法绕过准入层，
 * 也无法读写不属于它的数据。扩展工具（MCP）和内置工具拿到的是同一个上下文。
 */
export interface ToolContext {
  readonly taskId: TaskId;
  readonly callId: CallId;
  /** 这次调用的 span。对外请求应按 W3C Trace Context 把它传下去。 */
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
  /** 非幂等工具的重放保护键；幂等工具为 undefined。 */
  readonly idempotencyKey?: string;
  /** 大结果写这里，返回句柄，不要塞进 summary。 */
  putArtifact(data: Uint8Array | string, meta: { mime: string; summary: string }): Promise<ArtifactRef>;
  /** 字段只接受标量与资源引用，禁止 dump 对象。见 docs/architecture.md §2.4。 */
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Readonly<Record<string, LogField>>): void;
}

/** 工具作者实现这个。返回值还会经过归一化阶段，不需要自己拼信封。 */
export type ToolHandler = (args: unknown, cx: ToolContext) => Promise<ToolOutput>;

/** 工具的原始返回。归一化阶段会把它包成 ToolResult。 */
export interface ToolOutput {
  /** 进上下文的短文本。归一化阶段会按 summaryTokenLimit 截断。 */
  readonly summary: string;
  /** 小的结构化结果才放这里；大结果走 putArtifact。 */
  readonly data?: unknown;
  readonly artifactRef?: ArtifactRef;
}

/**
 * 归一化后的统一信封。**所有工具，内置和扩展，都返回这个形状。**
 * summary 是唯一保证进上下文的字段。
 */
export interface ToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
  readonly artifactRef?: ArtifactRef;
  readonly error?: ToolErrorShape;
  readonly metrics: ToolMetrics;
}

export interface ToolMetrics {
  readonly ms: number;
  readonly bytes: number;
  readonly retries: number;
  readonly costUSD?: number;
}

/** 落进事件日志的精简版（不含 data/summary 正文，避免日志膨胀）。 */
export interface ToolResultMeta {
  readonly ok: boolean;
  readonly errorCode?: ToolErrorShape['code'];
  readonly artifactRef?: ArtifactRef;
  readonly metrics: ToolMetrics;
}
