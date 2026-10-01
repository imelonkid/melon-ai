import type { ModelEntry, ModelPrice, ModelTier, PlanPricing } from '@melon-ai/core';
import { ANTHROPIC_MODELS, AnthropicChatModel } from './adapter.js';
import type { AnthropicModelId } from './adapter.js';

/** 不指定模型时用的 Claude 模型。宿主的配置页拿它做占位，不必自己再写一份。 */
export const CLAUDE_DEFAULT_MODEL: AnthropicModelId = 'claude-opus-5-5';

export interface ClaudeOptions {
  /** 不传时由 SDK 读 ANTHROPIC_API_KEY。 */
  readonly apiKey?: string;
  /** 默认 claude-opus-5。也可以是目录里没有的模型 id（新模型、兼容网关）。 */
  readonly model?: string;
  readonly baseURL?: string;
  readonly quality?: number;
  /** 不传按模型定：Opus 强、Sonnet 标准、Haiku 基础。 */
  readonly tier?: ModelTier;
  /** 不传用内置价格表。 */
  readonly price?: ModelPrice;
  /** Anthropic 兼容的网关（阿里 Coding Plan 等）：厂商标识与名字。不传是 Anthropic 官方。 */
  readonly egress?: string;
  readonly label?: string;
  /** 套餐计费。 */
  readonly plan?: PlanPricing;
}

export const CLAUDE_TIERS: Readonly<Partial<Record<string, ModelTier>>> = {
  'claude-fable-5-1': 'strong', 'claude-opus-5-5': 'strong', 'claude-opus-5': 'strong',
  'claude-sonnet-5-5': 'standard', 'claude-sonnet-5': 'standard', 'claude-haiku-4-5': 'basic',
};

/**
 * Claude。放在 `@melon-ai/llm/anthropic` 子路径 —— 依赖 `@anthropic-ai/sdk`，
 * 不用 Claude 的宿主不必装。
 */
export function claude(o: ClaudeOptions = {}): ModelEntry {
  const model = o.model ?? CLAUDE_DEFAULT_MODEL;
  const known = (ANTHROPIC_MODELS as Record<string, { inUSD: number; outUSD: number } | undefined>)[model];
  // 读缓存按输入价的十分之一（写缓存的 1.25 倍没单独算，按普通输入计，略微低估）
  const builtin = known ? { input: known.inUSD, cachedInput: known.inUSD * 0.1, output: known.outUSD, currency: 'USD' as const } : undefined;
  const price = o.price ?? builtin;
  const tier = o.tier ?? CLAUDE_TIERS[model];
  return {
    label: o.label ?? 'Claude',
    model: new AnthropicChatModel({
      model,
      ...(o.apiKey !== undefined ? { apiKey: o.apiKey } : {}),
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    }),
    quality: o.quality ?? 10,
    costUSD: price ? price.input * (price.currency === 'USD' ? 1 : 1 / 7.2) : 3,
    egress: o.egress ?? 'anthropic',
    ...(tier ? { tier } : {}),
    ...(price ? { price, priceSource: o.price ? 'manual' as const : 'builtin' as const } : {}),
    ...(o.plan ? { plan: o.plan } : {}),
  };
}
