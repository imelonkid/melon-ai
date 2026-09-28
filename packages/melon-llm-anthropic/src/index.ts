import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatModel, GenerateRequest, GenerateResult, Message, ModelCapabilities, ModelToolCall, Usage,
} from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';

/**
 * 模型目录。
 *
 * 只写**确切的 model id**，不拼日期后缀 —— 带日期的变体是训练数据里的旧写法，会 404。
 * 价格单位：美元 / 百万 token。
 */
export const ANTHROPIC_MODELS = {
  'claude-opus-5': { contextWindow: 1_000_000, maxOutput: 128_000, inUSD: 5, outUSD: 25 },
  'claude-sonnet-5': { contextWindow: 1_000_000, maxOutput: 128_000, inUSD: 2, outUSD: 10 },
  'claude-haiku-4-5': { contextWindow: 200_000, maxOutput: 64_000, inUSD: 1, outUSD: 5 },
} as const;

export type AnthropicModelId = keyof typeof ANTHROPIC_MODELS;

export interface AnthropicModelOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: AnthropicModelId;
  /** 思考深度。low..max，默认 high。 */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxTokens?: number;
  /**
   * 自适应思考。默认开 —— Agent 的规划本来就是「remotely complicated」。
   * 注意 `budget_tokens` 在 Opus 5 上已被移除，传了会 400。
   */
  readonly thinking?: boolean;
  readonly timeoutMs?: number;
}

const roleOf = (m: Message): 'user' | 'assistant' =>
  m.role === 'assistant' ? 'assistant' : 'user';

/**
 * Claude 适配器。
 *
 * 几处刻意的取舍：
 *
 * 1. **历史以纯文本回传，不复原 tool_use / tool_result 块。**
 *    `Message.content` 是字符串；观察结果由 planner 渲染成文本。
 *    这样跨供应商一致，且不必在契约里引入块结构。
 *    代价是模型看不到自己上一轮的结构化调用 —— 实测对 ReAct 影响不大。
 *
 * 2. **缓存断点打在 system 上。** 渲染顺序是 tools → system → messages，
 *    而 system（宪章 + 人设）是最稳定的一段，正好对上 §2.4 的前缀稳定性要求。
 *
 * 3. **不强制 tool_choice。** Opus 5.5 / Fable 5.1 上 `any` / `tool` 会 400，
 *    统一用 `auto` + 提示词里点名，配合 `strict: true` 保证参数合法。
 */
export class AnthropicChatModel implements ChatModel {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  private readonly client: Anthropic;
  private readonly opts: AnthropicModelOptions;

  constructor(opts: AnthropicModelOptions = {}) {
    const model = opts.model ?? 'claude-opus-5';
    const spec = ANTHROPIC_MODELS[model];
    this.id = model;
    this.opts = opts;
    this.capabilities = {
      contextWindow: spec.contextWindow,
      maxOutputTokens: spec.maxOutput,
      tools: true,
      jsonSchema: true,
      promptCache: true,
    };
    this.client = new Anthropic({
      // 不传则由 SDK 从 ANTHROPIC_API_KEY / ant auth 配置解析
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = req.messages.filter((m) => m.role !== 'system');

    try {
      const res = await this.client.messages.create({
        model: this.id,
        max_tokens: req.maxOutputTokens ?? this.opts.maxTokens ?? 16_000,
        ...(system
          ? {
              // 缓存断点打在最稳定的一段上
              system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
            }
          : {}),
        messages: rest.map((m) => ({ role: roleOf(m), content: m.content })),
        ...(req.tools && req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.input as Anthropic.Tool['input_schema'],
                // 保证参数严格符合 schema，省掉一轮「参数错了重来」
                strict: true,
              })),
            }
          : {}),
        // 自适应思考。budget_tokens 在 Opus 5 上已移除，传了会 400
        ...(this.opts.thinking === false ? {} : { thinking: { type: 'adaptive' as const } }),
        output_config: { effort: this.opts.effort ?? 'high' },
      });

      // 安全分类器拒绝时是 HTTP 200 + stop_reason=refusal，必须在读 content 前检查
      if (res.stop_reason === 'refusal') {
        return {
          text: `模型拒绝了这次请求${res.stop_details ? `（${res.stop_details.category ?? '未分类'}）` : ''}`,
          usage: toUsage(res.usage, this.id),
          modelId: res.model,
          stopReason: 'filtered',
        };
      }

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const toolCalls: ModelToolCall[] = res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input }));

      return {
        text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: toUsage(res.usage, this.id),
        modelId: res.model,
        stopReason: res.stop_reason === 'max_tokens' ? 'length'
          : res.stop_reason === 'tool_use' ? 'tool' : 'stop',
      };
    } catch (e) {
      throw toMelonError(e);
    }
  }
}

function toUsage(u: Anthropic.Usage, model: string): Usage {
  const spec = ANTHROPIC_MODELS[model as AnthropicModelId];
  const cached = u.cache_read_input_tokens ?? 0;
  const created = u.cache_creation_input_tokens ?? 0;
  const base = {
    inputTokens: u.input_tokens + cached + created,
    outputTokens: u.output_tokens,
    cachedInputTokens: cached,
  };
  if (!spec) return base;
  // 缓存读取约 0.1x，写入约 1.25x
  const costUSD =
    ((u.input_tokens + created * 1.25 + cached * 0.1) * spec.inUSD +
      u.output_tokens * spec.outUSD) / 1_000_000;
  return { ...base, costUSD };
}

/** 把 SDK 的分类异常映射成对模型可操作的错误码。按最具体到最宽泛排。 */
function toMelonError(e: unknown): ToolError {
  if (e instanceof Anthropic.AuthenticationError) {
    return new ToolError('FATAL', 'Anthropic API key 无效或缺失', {
      hint: '检查 ANTHROPIC_API_KEY 或应用内的模型配置',
    });
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ToolError('RATE_LIMITED', `触发限流：${e.message}`);
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new ToolError('INVALID_ARGS', `请求不合法：${e.message}`);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new ToolError('UPSTREAM', `连接 Anthropic 失败：${e.message}`);
  }
  if (e instanceof Anthropic.APIError) {
    return new ToolError(e.status && e.status >= 500 ? 'UPSTREAM' : 'FATAL', `Anthropic ${e.status}：${e.message}`);
  }
  return new ToolError('FATAL', e instanceof Error ? e.message : String(e));
}
