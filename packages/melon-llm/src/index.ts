/**
 * @melon-ai/llm —— 模型。
 *
 * - router：按用途 × 策略 × 健康选模型
 * - planner：ReAct 规划器（Planner 端口的一种实现）
 * - openai：OpenAI 兼容适配器（OpenAI / DeepSeek / 通义 / Kimi），只用 fetch，不带额外依赖
 *
 * Claude 适配器依赖 @anthropic-ai/sdk，放在 `@melon-ai/llm/anthropic` 子路径 ——
 * 不用 Claude 的宿主不必装 SDK。
 */
export * from './router/index.js';
export * from './planner/index.js';
export * from './openai/index.js';
