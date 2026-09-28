import type { ModelTool } from './model.js';

/**
 * 工具名的传输层编解码。
 *
 * melon-ai 的 `ToolId` 是 `${skillId}.${name}`（强制命名空间，见 tool.ts），
 * 但**供应商不接受点号**：OpenAI 兼容接口要求 `^[a-zA-Z0-9_-]+$`，
 * Anthropic 同样限制为 `^[a-zA-Z0-9_-]{1,64}$`。
 *
 * 这是传输层细节，不该反过来污染命名空间设计 ——
 * 所以由适配器在发送前编码、在收到工具调用时解码。
 */
export interface ToolNameCodec {
  /** 原始 id → 供应商可接受的名字。 */
  encode(id: string): string;
  /** 供应商返回的名字 → 原始 id。无映射时原样返回。 */
  decode(name: string): string;
  /** 编码后的工具列表。 */
  readonly tools: readonly ModelTool[];
}

const SAFE = /[^a-zA-Z0-9_-]/g;
const MAX = 64;

/**
 * 为一次请求建立编解码表。
 *
 * 截断与替换都可能产生碰撞，所以带去重后缀 —— 两个工具映射到同一个名字时，
 * 模型返回的调用就无法反解，那是静默的错路由。
 */
export function toolNameCodec(tools: readonly ModelTool[]): ToolNameCodec {
  const fwd = new Map<string, string>();
  const rev = new Map<string, string>();

  for (const t of tools) {
    const base = t.name.replace(SAFE, '_').slice(0, MAX) || 'tool';
    let safe = base;
    let n = 1;
    while (rev.has(safe)) {
      const suffix = `_${++n}`;
      safe = base.slice(0, MAX - suffix.length) + suffix;
    }
    fwd.set(t.name, safe);
    rev.set(safe, t.name);
  }

  return {
    encode: (id) => fwd.get(id) ?? id.replace(SAFE, '_').slice(0, MAX),
    decode: (name) => rev.get(name) ?? name,
    tools: tools.map((t) => ({ ...t, name: fwd.get(t.name) ?? t.name })),
  };
}
