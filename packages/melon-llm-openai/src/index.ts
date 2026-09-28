import type {
  ChatModel, GenerateRequest, GenerateResult, ModelCapabilities, ModelToolCall, Usage,
} from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';

/**
 * 预置的 OpenAI 兼容服务。
 *
 * 用 `fetch` 而不是 openai SDK：这一层只需要 `/chat/completions` 一个端点，
 * 引 SDK 会为了几十行代码多打一个包 —— 对 Electron 的体积是实打实的。
 */
export const OPENAI_COMPATIBLE_PRESETS = {
  openai: { baseURL: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY' },
  /** 通义千问的 OpenAI 兼容模式。 */
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', env: 'MOONSHOT_API_KEY' },
} as const;

export type OpenAICompatiblePreset = keyof typeof OPENAI_COMPATIBLE_PRESETS;

export interface OpenAICompatibleOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly preset?: OpenAICompatiblePreset;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** 每百万 token 的价格，用于成本归因。不填则不计费用。 */
  readonly pricing?: { readonly inUSD: number; readonly outUSD: number };
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  };
  finish_reason?: string;
}

interface ChatResponse {
  model?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

export class OpenAICompatibleChatModel implements ChatModel {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    const preset = opts.preset ? OPENAI_COMPATIBLE_PRESETS[opts.preset] : undefined;
    this.id = opts.model;
    this.baseURL = (opts.baseURL ?? preset?.baseURL ?? '').replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? (preset ? process.env[preset.env] ?? '' : '');
    this.doFetch = opts.fetchImpl ?? fetch;
    if (!this.baseURL) throw new Error('OpenAICompatibleChatModel 需要 baseURL 或 preset');
    this.capabilities = {
      contextWindow: opts.contextWindow ?? 128_000,
      maxOutputTokens: opts.maxTokens ?? 8_192,
      tools: true,
      jsonSchema: true,
      // 多数兼容服务有自动前缀缓存，但不保证；按没有算，装配器的排序依然有益无害
      promptCache: false,
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.apiKey) {
      throw new ToolError('FATAL', `${this.id} 缺少 API key`, { hint: '在设置里填入，或设对应环境变量' });
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 120_000);
    if (req.signal) req.signal.addEventListener('abort', () => ctl.abort(), { once: true });

    try {
      const res = await this.doFetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: ctl.signal,
        body: JSON.stringify({
          model: this.id,
          max_tokens: req.maxOutputTokens ?? this.opts.maxTokens ?? 8_192,
          messages: req.messages.map((m) => ({
            role: m.role === 'tool' ? 'user' : m.role,
            content: m.content,
          })),
          ...(req.tools && req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.input },
                })),
                tool_choice: req.toolChoice === 'required' ? 'required' : 'auto',
              }
            : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
      });

      const body = (await res.json()) as ChatResponse;
      if (!res.ok) throw httpError(res.status, body.error?.message ?? res.statusText);

      const choice = body.choices?.[0];
      // 工具参数是字符串，必须 JSON.parse —— 不同供应商的转义策略不同，不能做字符串匹配
      const toolCalls: ModelToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        args: safeParse(c.function.arguments),
      }));

      return {
        text: choice?.message?.content ?? '',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: this.toUsage(body),
        modelId: body.model ?? this.id,
        stopReason: choice?.finish_reason === 'length' ? 'length'
          : choice?.finish_reason === 'tool_calls' ? 'tool'
          : choice?.finish_reason === 'content_filter' ? 'filtered' : 'stop',
      };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ToolError('UPSTREAM', `${this.id} 请求超时`, { hint: '可以重试，或换更小的上下文' });
      }
      throw new ToolError('UPSTREAM', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private toUsage(body: ChatResponse): Usage {
    const inTok = body.usage?.prompt_tokens ?? 0;
    const outTok = body.usage?.completion_tokens ?? 0;
    const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const base: Usage = { inputTokens: inTok, outputTokens: outTok, cachedInputTokens: cached };
    const p = this.opts.pricing;
    return p ? { ...base, costUSD: (inTok * p.inUSD + outTok * p.outUSD) / 1_000_000 } : base;
  }
}

/** 参数解析失败不能静默吞掉 —— 那会让模型以为调用成功了。 */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new ToolError('INVALID_ARGS', `模型返回的工具参数不是合法 JSON：${s.slice(0, 200)}`, {
      hint: '重新生成这次调用',
    });
  }
}

function httpError(status: number, message: string): ToolError {
  if (status === 401 || status === 403) {
    return new ToolError('FATAL', `鉴权失败（${status}）：${message}`, { hint: '检查 API key' });
  }
  if (status === 429) return new ToolError('RATE_LIMITED', `触发限流：${message}`);
  if (status === 400) return new ToolError('INVALID_ARGS', `请求不合法：${message}`);
  if (status >= 500) return new ToolError('UPSTREAM', `上游 ${status}：${message}`);
  return new ToolError('FATAL', `HTTP ${status}：${message}`);
}
