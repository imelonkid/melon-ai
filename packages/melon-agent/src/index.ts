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
 * - `@melon-ai/agent/web`       联网技能（Node）；搜索服务的厂商实现在扩展包 `@melon-ai/plugins`
 * - `@melon-ai/agent/mail`      发邮件（SMTP，Node）
 * - `@melon-ai/agent/agentskills` 加载用户装的 Agent Skills（Claude 的技能格式，Node）
 * - `@melon-ai/agent/node`      Node 原生的平台实现（可选；根入口的默认实现在 Node 上也能用）
 */
export * from './create.js';
export * from './context.js';
export { memoriesFor, memoryMessage } from './memory.js';
export * from './platform.js';

// ── 宿主常用的部件，从这里一并拿到，不必再装内部包 ──
export {
  defineTool, defineSkill, toSchema, basicValidator, ToolRegistry, reviewTool, proposalToWhen,
} from '@melon-ai/skills';
export type {
  Tool, ToolSpec, SkillSpec, InputShape, FieldSpec, RegistrationReport, RejectedTool, ProposeArgs, ProposedWhen,
} from '@melon-ai/skills';
export {
  deepseek, qwen, openai, kimi, zhipu, compatible, DEFAULT_MODELS, ModelPool, testModel, DEFAULT_ACTION_WORDS, PRICES, TIERS, costOf, modelKey,
} from '@melon-ai/llm';
export type {
  ProviderOptions, CompatibleOptions, RouteStrategy, ModelTestResult, FxRates, UsageSummary, UsageBucket, UsageGroup, UsageTotals,
  SummaryOptions, RoutingRule, RoutingRules, RouteExplanation, RouteCandidate,
} from '@melon-ai/llm';
export { whenToRule, describeRule, hostTimeZone } from '@melon-ai/engine';
export type { When } from '@melon-ai/engine';
export { memoryStorage } from '@melon-ai/store';
export { ToolError, BUILTIN_TOOLS, TIER_RANK } from '@melon-ai/core';
export type {
  Task, TaskState, TaskEvent, Sequenced, Schedule, ScheduleStatus, ModelEntry, PolicyMode,
  ApprovalDecision, ApprovalRequest, Grant, Memory, SkillProvider, ToolContext, ToolOutput, Message, AnswerDraft,
  ModelPrice, Currency, UsageRecord, UsageQuery, ModelTier, RouteContext, PlanPricing, PriceSource, PriceSheet, PriceSync, PriceChange,
} from '@melon-ai/core';

/** 兼容旧名。 */
export { assemble } from './assemble.js';
export type { AssembleOptions, AssembledAgent } from './assemble.js';
