import type { ModelEntry } from '@melon-ai/core';
import { ANTHROPIC_MODELS, AnthropicChatModel } from './adapter.js';
import type { AnthropicModelId } from './adapter.js';

/** 不指定模型时用的 Claude 模型。宿主的配置页拿它做占位，不必自己再写一份。 */
export const CLAUDE_DEFAULT_MODEL: AnthropicModelId = 'claude-opus-5';

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
  const model = o.model ?? CLAUDE_DEFAULT_MODEL;
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
    // 读缓存按输入价的十分之一（写缓存的 1.25 倍没单独算，按普通输入计，略微低估）
    price: {
      input: ANTHROPIC_MODELS[model].inUSD, cachedInput: ANTHROPIC_MODELS[model].inUSD * 0.1,
      output: ANTHROPIC_MODELS[model].outUSD, currency: 'USD',
    },
  };
}
