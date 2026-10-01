/**
 * `@melon-ai/agent/anthropic` —— Claude。需要宿主装 `@anthropic-ai/sdk`。
 *
 * ```ts
 * import { claude } from '@melon-ai/agent/anthropic';
 * const agent = await createAgent({ models: [claude({ apiKey })] });
 * ```
 */
export { claude, AnthropicChatModel, ANTHROPIC_MODELS, CLAUDE_DEFAULT_MODEL, CLAUDE_TIERS } from '@melon-ai/llm/anthropic';
export type { ClaudeOptions, AnthropicModelId } from '@melon-ai/llm/anthropic';
