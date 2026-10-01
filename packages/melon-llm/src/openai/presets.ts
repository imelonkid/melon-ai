import type { ModelEntry, ModelPrice, ModelTier } from '@melon-ai/core';
import { OpenAICompatibleChatModel } from './adapter.js';
import { convert } from '../shared/money.js';
import type { OpenAICompatiblePreset } from './adapter.js';

export interface ProviderOptions {
  /** 不传时读各家的环境变量（DEEPSEEK_API_KEY 等）。 */
  readonly apiKey?: string;
  /** 不传用各家的默认模型。 */
  readonly model?: string;
  /** 代理或自建网关。 */
  readonly baseURL?: string;
  /** 覆盖路由属性：质量分、每百万输入 token 的美元价。 */
  readonly quality?: number;
  readonly costUSD?: number;
  /** 价格。不传用内置价格表（有的话）；内置表里也没有就是「未计价」。 */
  readonly price?: ModelPrice;
  /** 档次。不传用内置档次表（有的话）；都没有就是「未定档」，不参与自动路由。 */
  readonly tier?: ModelTier;
}

interface Preset {
  readonly preset: OpenAICompatiblePreset;
  readonly label: string;
  readonly model: string;
  readonly quality: number;
  readonly costUSD: number;
  readonly egress: string;
  readonly contextWindow?: number;
}

/**
 * 各家的默认值。质量分与价格只用于路由排序，不追求精确 ——
 * 宿主要调整时在工厂函数里传 `quality` / `costUSD`。
 */
/** DeepSeek 的高峰时段：北京时间工作日 9–12、14–18 点，价格是平时的两倍。 */
const DEEPSEEK_PEAK = {
  multiplier: 2,
  timeZone: 'Asia/Shanghai',
  windows: [
    { days: [1, 2, 3, 4, 5], from: '09:00', to: '12:00' },
    { days: [1, 2, 3, 4, 5], from: '14:00', to: '18:00' },
  ],
} as const;
const DEEPSEEK_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const DEEPSEEK_FLASH: ModelPrice = { input: 1, cachedInput: 0.02, output: 4, currency: 'CNY', peak: DEEPSEEK_PEAK, source: DEEPSEEK_SOURCE };

/**
 * 内置价格表（每百万 token，空闲时段价），只收**核对过官方文档**的。
 * 不在表里的模型不计价：照常记用量，费用标「未计价」—— 不拿粗估的数冒充花费。
 * 以后按官方文档自动同步（插件里每家一个解析器），这张表是同步不到时的兜底。
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'deepseek-flash': DEEPSEEK_FLASH,
  // 官方文档：旧名已弃用，路由到 deepseek-flash，价格相同
  'deepseek-v4-flash': DEEPSEEK_FLASH,
  'deepseek-v4-flash-vision-exp': DEEPSEEK_FLASH,
  'deepseek-v4-pro': { input: 4.5, cachedInput: 0.15, output: 13.5, currency: 'CNY', peak: DEEPSEEK_PEAK, source: DEEPSEEK_SOURCE },
};

/**
 * 内置档次：按厂商对自家模型的定位（官方文档里的「旗舰 / 标准 / 轻量」）。只收有把握的，其余由用户定。
 */
export const TIERS: Readonly<Record<string, ModelTier>> = {
  'deepseek-flash': 'standard',
  'deepseek-v4-flash': 'standard',
  'deepseek-v4-flash-vision-exp': 'standard',
  'deepseek-v4-pro': 'strong',
};

const PRESETS = {
  deepseek: { preset: 'deepseek', label: 'DeepSeek', model: 'deepseek-flash', quality: 6, costUSD: 0.3, egress: 'deepseek', contextWindow: 64_000 },
  qwen: { preset: 'qwen', label: '通义千问', model: 'qwen-max', quality: 6, costUSD: 0.4, egress: 'aliyun', contextWindow: 32_000 },
  openai: { preset: 'openai', label: 'GPT', model: 'gpt-4o', quality: 8, costUSD: 2.5, egress: 'openai' },
  kimi: { preset: 'moonshot', label: 'Kimi', model: 'moonshot-v1-128k', quality: 6, costUSD: 1.7, egress: 'moonshot', contextWindow: 128_000 },
} as const satisfies Record<string, Preset>;

/** 路由排序用的「每百万输入 token 美元价」：有价格就按价格折算。 */
const sortCost = (price: ModelPrice | undefined, fallback: number): number =>
  price ? convert(price.input, price.currency, 'USD') : fallback;

function entry(p: Preset, o: ProviderOptions): ModelEntry {
  const model = o.model ?? p.model;
  const price = o.price ?? PRICES[model];
  const tier = o.tier ?? TIERS[model];
  return {
    label: p.label,
    model: new OpenAICompatibleChatModel({
      model,
      preset: p.preset,
      ...(o.apiKey !== undefined ? { apiKey: o.apiKey } : {}),
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
      ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),
    }),
    quality: o.quality ?? p.quality,
    costUSD: o.costUSD ?? sortCost(price, p.costUSD),
    egress: p.egress,
    ...(price ? { price } : {}),
    ...(tier ? { tier } : {}),
  };
}

/** DeepSeek。 */
export const deepseek = (o: ProviderOptions = {}): ModelEntry => entry(PRESETS.deepseek, o);
/** 通义千问（阿里云百炼的 OpenAI 兼容模式）。 */
export const qwen = (o: ProviderOptions = {}): ModelEntry => entry(PRESETS.qwen, o);
/** OpenAI。 */
export const openai = (o: ProviderOptions = {}): ModelEntry => entry(PRESETS.openai, o);
/** Kimi（月之暗面）。 */
export const kimi = (o: ProviderOptions = {}): ModelEntry => entry(PRESETS.kimi, o);

export interface CompatibleOptions {
  /** 给人看的名字，如「智谱」。 */
  readonly label: string;
  /** OpenAI 兼容接口的地址，如 https://open.bigmodel.cn/api/paas/v4 */
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey: string;
  /**
   * 数据发往的供应商标识。**进审计** —— 借 `openai()` 接别家会把它记成 openai，
   * 「哪份数据被哪个供应商看到过」就记错了，所以这里必填。
   */
  readonly egress: string;
  readonly quality?: number;
  /** 每百万输入 token 的美元价。不填按 1 估，只影响 cost 策略的排序。 */
  readonly costUSD?: number;
  /** 价格。不填就是「未计价」。 */
  readonly price?: ModelPrice;
  /** 档次。不填就是「未定档」。 */
  readonly tier?: ModelTier;
  readonly contextWindow?: number;
}

/**
 * 任意 OpenAI 兼容的供应商或网关（智谱、硅基流动、自建 vLLM……）。
 * 内置的几家（deepseek / qwen / openai / kimi）只是它预填了默认值的版本。
 */
export function compatible(o: CompatibleOptions): ModelEntry {
  return {
    label: o.label,
    model: new OpenAICompatibleChatModel({
      model: o.model,
      apiKey: o.apiKey,
      baseURL: o.baseURL,
      ...(o.contextWindow ? { contextWindow: o.contextWindow } : {}),
    }),
    quality: o.quality ?? 5,
    costUSD: o.costUSD ?? sortCost(o.price, 1),
    egress: o.egress,
    ...(o.price ? { price: o.price } : {}),
    ...(o.tier ? { tier: o.tier } : {}),
  };
}

/** 各家的默认模型名，给宿主的配置页做占位提示。 */
export const DEFAULT_MODELS = {
  deepseek: PRESETS.deepseek.model,
  qwen: PRESETS.qwen.model,
  openai: PRESETS.openai.model,
  kimi: PRESETS.kimi.model,
} as const;
