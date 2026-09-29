/**
 * @melon-ai/agent —— 宿主的入口。**装这一个包就能跑。**
 *
 * ```ts
 * import { createAgent, defineTool, deepseek } from '@melon-ai/agent';
 * ```
 *
 * 可选能力走子路径（需要额外依赖或特定运行时）：
 * - `@melon-ai/agent/sqlite`    持久化存储（需要 better-sqlite3）
 * - `@melon-ai/agent/anthropic` Claude（需要 @anthropic-ai/sdk）
 */
export * from './create.js';
export * from './context.js';
export * from './platform.js';

// ── 宿主常用的部件，从这里一并拿到，不必再装内部包 ──
export { defineTool, toSchema, basicValidator, ToolRegistry } from '@melon-ai/skills';
export type { Tool, ToolSpec, InputShape, FieldSpec } from '@melon-ai/skills';
export { deepseek, qwen, openai, kimi, DEFAULT_MODELS, ModelPool, testModel } from '@melon-ai/llm';
export type { ProviderOptions, RouteStrategy, ModelTestResult } from '@melon-ai/llm';
export { whenToRule, describeRule, hostTimeZone } from '@melon-ai/engine';
export type { When } from '@melon-ai/engine';
export { memoryStorage } from '@melon-ai/store';
export { ToolError } from '@melon-ai/core';
export type {
  Task, TaskState, TaskEvent, Sequenced, Schedule, ScheduleStatus, ModelEntry, PolicyMode,
  ApprovalDecision, SkillProvider, ToolContext, ToolOutput, Message,
} from '@melon-ai/core';

/** 兼容旧名。 */
export { assemble } from './assemble.js';
export type { AssembleOptions, AssembledAgent } from './assemble.js';
