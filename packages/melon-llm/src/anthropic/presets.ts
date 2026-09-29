import type { ModelEntry } from '@melon-ai/core';
import { ANTHROPIC_MODELS, AnthropicChatModel } from './adapter.js';
import type { AnthropicModelId } from './adapter.js';

export interface ClaudeOptions {
  /** 不传时由 SDK 读 ANTHROPIC_API_KEY。 */
  readonly apiKey?: string;
  /** 默认 claude-opus-5。 */
  readonly model?: AnthropicModelId;
  readonly baseURL?: string;
  readonly quality?: number;
}

/**
 * Claude。放在 `@melon-ai/llm/anthropic` 子路径 —— 依赖 `@anthropic-ai/sdk`，
 * 不用 Claude 的宿主不必装。
 */
export function claude(o: ClaudeOptions = {}): ModelEntry {
  const model = o.model ?? 'claude-opus-5';
  return {
    label: 'Claude',
    model: new AnthropicChatModel({
      model,
      ...(o.apiKey !== undefined ? { apiKey: o.apiKey } : {}),
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    }),
    quality: o.quality ?? 10,
    costUSD: ANTHROPIC_MODELS[model].inUSD,
    egress: 'anthropic',
  };
}
