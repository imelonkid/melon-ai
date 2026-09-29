import type { ModelEntry } from '@melon-ai/core';
import { OpenAICompatibleChatModel } from './adapter.js';
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
const PRESETS = {
  deepseek: { preset: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', quality: 6, costUSD: 0.3, egress: 'deepseek', contextWindow: 64_000 },
  qwen: { preset: 'qwen', label: '通义千问', model: 'qwen-max', quality: 6, costUSD: 0.4, egress: 'aliyun', contextWindow: 32_000 },
  openai: { preset: 'openai', label: 'GPT', model: 'gpt-4o', quality: 8, costUSD: 2.5, egress: 'openai' },
  kimi: { preset: 'moonshot', label: 'Kimi', model: 'moonshot-v1-128k', quality: 6, costUSD: 1.7, egress: 'moonshot', contextWindow: 128_000 },
} as const satisfies Record<string, Preset>;

function entry(p: Preset, o: ProviderOptions): ModelEntry {
  const costUSD = o.costUSD ?? p.costUSD;
  return {
    label: p.label,
    model: new OpenAICompatibleChatModel({
      model: o.model ?? p.model,
      preset: p.preset,
      ...(o.apiKey !== undefined ? { apiKey: o.apiKey } : {}),
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
      ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),
      // 输出价按输入价的 4 倍估 —— 各家大致如此，只用于成本归因
      pricing: { inUSD: costUSD, outUSD: costUSD * 4 },
    }),
    quality: o.quality ?? p.quality,
    costUSD,
    egress: p.egress,
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
  readonly contextWindow?: number;
}

/**
 * 任意 OpenAI 兼容的供应商或网关（智谱、硅基流动、自建 vLLM……）。
 * 内置的几家（deepseek / qwen / openai / kimi）只是它预填了默认值的版本。
 */
export function compatible(o: CompatibleOptions): ModelEntry {
  const costUSD = o.costUSD ?? 1;
  return {
    label: o.label,
    model: new OpenAICompatibleChatModel({
      model: o.model,
      apiKey: o.apiKey,
      baseURL: o.baseURL,
      ...(o.contextWindow ? { contextWindow: o.contextWindow } : {}),
      pricing: { inUSD: costUSD, outUSD: costUSD * 4 },
    }),
    quality: o.quality ?? 5,
    costUSD,
    egress: o.egress,
  };
}

/** 各家的默认模型名，给宿主的配置页做占位提示。 */
export const DEFAULT_MODELS = {
  deepseek: PRESETS.deepseek.model,
  qwen: PRESETS.qwen.model,
  openai: PRESETS.openai.model,
  kimi: PRESETS.kimi.model,
} as const;
