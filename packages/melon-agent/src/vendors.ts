import type { ModelEntry, ModelProvider } from '@melon-ai/core';
import { deepseek, kimi, openai, qwen, zhipu } from '@melon-ai/llm';
import type { ProviderOptions } from '@melon-ai/llm';

/** 接一家模型要填的一个值（宿主据此画自己的配置表单）。 */
export interface ModelVendorField {
  readonly key: string;
  readonly label: string;
  /** 密钥类：宿主存起来、只显示打码。 */
  readonly secret?: boolean;
  readonly optional?: boolean;
  readonly placeholder?: string;
  readonly help?: string;
}

/** 一家模型厂商：id 和要填的值。 */
export interface ModelVendor {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
  readonly fields: readonly ModelVendorField[];
}

/**
 * 引擎自带的模型厂商（OpenAI 兼容协议的预设）：接一家要填哪些值（宿主据此画自己的配置表单），
 * 再用 `providerFrom` 把填好的值变成 `ModelProvider` 交给引擎 —— 宿主不用自己写厂商适配。
 * Claude 在 `@melon-ai/agent/anthropic` 子路径（要额外装 SDK），不在这里。
 */
const MAKERS: Readonly<Record<string, (o: ProviderOptions) => ModelEntry>> = { deepseek, qwen, zhipu, kimi, openai };

const fields = (env: string): ModelVendor['fields'] => [
  { key: 'apiKey', label: 'API key', secret: true, placeholder: `${env} 那个 key` },
  { key: 'baseURL', label: '服务地址', optional: true, placeholder: '不填用官方地址', help: '走代理或自建网关时才填' },
  { key: 'models', label: '只用这些模型', optional: true, placeholder: '逗号分隔；不填按官方能用的全部', help: '比如只想用便宜的那个' },
];

export const MODEL_VENDORS: readonly ModelVendor[] = [
  { id: 'deepseek', label: 'DeepSeek', note: '深度求索', fields: fields('DeepSeek') },
  { id: 'qwen', label: '通义千问', note: '阿里云百炼', fields: fields('百炼') },
  { id: 'zhipu', label: '智谱', note: '智谱 AI', fields: fields('智谱') },
  { id: 'kimi', label: 'Kimi', note: '月之暗面', fields: fields('Kimi') },
  { id: 'openai', label: 'GPT', note: 'OpenAI', fields: fields('OpenAI') },
];

/** 连接配置的指纹（只为发现变化：换了 key / 地址立即重拉模型列表）。不可逆、很短，不泄露 key。 */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export interface ProviderFromOptions {
  /** 账户标识（同一家接了别的账户时区分，比如 `shared:deepseek`）。 */
  readonly id?: string;
  readonly group?: string;
  readonly priority?: number;
  readonly label?: string;
}

/**
 * 按 `MODEL_VENDORS` 里的一家和填好的值造 `ModelProvider`。认不出的厂商、没填 key 返回 null。
 * 「只用这些模型」：列表之外的模型造不出来（目录里不出现、不参与路由）。
 */
export function providerFrom(vendorId: string, values: Readonly<Record<string, string>>, o: ProviderFromOptions = {}): ModelProvider | null {
  const make = MAKERS[vendorId];
  const apiKey = (values['apiKey'] ?? '').trim();
  if (!make || !apiKey) return null;
  const baseURL = (values['baseURL'] ?? '').trim();
  const only = (values['models'] ?? '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  const vendor = make({ apiKey }).egress;
  return {
    vendor,
    ...(o.id !== undefined ? { id: o.id } : {}), ...(o.group !== undefined ? { group: o.group } : {}),
    ...(o.priority !== undefined ? { priority: o.priority } : {}), ...(o.label !== undefined ? { label: o.label } : {}),
    fingerprint: fingerprint(`${apiKey}|${baseURL}|${only.join(',')}`),
    make(modelId?: string): ModelEntry {
      const id = modelId ?? only[0];
      if (only.length && id !== undefined && !only.includes(id)) throw new Error(`没选用这个模型：${id}`);
      return make({ apiKey, ...(id !== undefined ? { model: id } : {}), ...(baseURL ? { baseURL } : {}) });
    },
  };
}
