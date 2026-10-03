import type {
  ChatModel, GenerateRequest, GenerateResult, Message, ModelCapabilities, ModelToolCall, Usage,
} from '@melon-ai/core';
import { billingError } from '../shared/account.js';
import { imagesOf, visionByName } from '../shared/vision.js';
import { ToolError } from '@melon-ai/core';
import { toolNameCodec } from '../shared/toolname.js';

/**
 * 预置的 OpenAI 兼容服务。
 *
 * 用 `fetch` 而不是 openai SDK：这一层只需要 `/chat/completions` 一个端点，
 * 引 SDK 会为了几十行代码多打一个包 —— 对 Electron 的体积是实打实的。
 */
/**
 * 能关思考的：请求里带 `thinking: { type: 'disabled' }`（DeepSeek、智谱的官方文档，2026-10）。
 * 智谱的 GLM-5.3 / GLM-5.3-Flash 是强制思考，关不掉 —— 不带。别家没有这个参数，也不带。
 */
const THINKING_OFF: Partial<Record<string, (model: string) => boolean>> = {
  deepseek: () => true,
  zhipu: (model) => !/^glm-5\.3(-flash)?$/i.test(model),
};

export const OPENAI_COMPATIBLE_PRESETS = {
  openai: { baseURL: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY' },
  /** 通义千问的 OpenAI 兼容模式。 */
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', env: 'MOONSHOT_API_KEY' },
  /** 智谱（官方文档的 OpenAI 兼容地址）。 */
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', env: 'ZHIPU_API_KEY' },
} as const;

export type OpenAICompatiblePreset = keyof typeof OPENAI_COMPATIBLE_PRESETS;

export interface OpenAICompatibleOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly preset?: OpenAICompatiblePreset;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** 能看图。不填按模型名判断（`visionByName`）。 */
  readonly vision?: boolean;
  /** 每百万 token 的价格，用于成本归因。不填则不计费用。 */
  readonly pricing?: { readonly inUSD: number; readonly outUSD: number };
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface ChatChoice {
  message?: {
    content?: string | null;
    /** 推理模型的思考过程（DeepSeek 推理模式等）。不是回答。 */
    reasoning_content?: string | null;
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
    /** DeepSeek 用自己的字段报缓存命中（官方文档：上下文硬盘缓存）。 */
    prompt_cache_hit_tokens?: number;
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
    // 非 Node 运行时没有 process：只用显式传入的 key
    this.apiKey = opts.apiKey ?? (preset ? globalThis.process?.env?.[preset.env] ?? '' : '');
    this.doFetch = opts.fetchImpl ?? fetch;
    if (!this.baseURL) throw new Error('OpenAICompatibleChatModel 需要 baseURL 或 preset');
    this.capabilities = {
      contextWindow: opts.contextWindow ?? 128_000,
      maxOutputTokens: opts.maxTokens ?? 8_192,
      tools: true,
      jsonSchema: true,
      // 多数兼容服务有自动前缀缓存，但不保证；按没有算，装配器的排序依然有益无害
      promptCache: false,
      vision: opts.vision ?? visionByName(opts.model),
    };
  }

  /**
   * 带图片的消息发成「文字 + 图片」的数组（OpenAI 的 image_url，data URL）。
   * 谁能收到图由路由决定（`capabilities.vision`，价格页写了输入模态的以它为准）—— 这里不再按名字二次判断。
   */
  private contentOf(m: Message): string | readonly Record<string, unknown>[] {
    const imgs = imagesOf(m);
    if (imgs.length === 0) return m.content;
    return [
      { type: 'text', text: m.content },
      ...imgs.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })),
    ];
  }

  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    if (!this.apiKey) throw new ToolError('FATAL', `${this.id} 缺少 API key`);
    const res = await this.doFetch(`${this.baseURL}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[]; error?: { message?: string } };
    if (!res.ok) throw httpError(res.status, body.error?.message ?? res.statusText);
    return (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.apiKey) {
      throw new ToolError('FATAL', `${this.id} 缺少 API key`, { hint: '由宿主传入 apiKey，或设置对应的环境变量' });
    }
    // 供应商不接受工具名里的点号，转码后发送、收到调用时再映射回来
    const codec = toolNameCodec(req.tools ?? []);
    const ctl = new AbortController();
    // 流式时按「多久没收到新内容」计时：长回答整体超过两分钟是正常的，卡住不动才是故障
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    let timer = setTimeout(() => ctl.abort(), timeoutMs);
    const alive = (): void => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), timeoutMs); };
    if (req.signal) req.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    const stream = !!(req.onText || req.onReasoning);

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
          ...(req.thinking === 'off' && this.opts.preset && THINKING_OFF[this.opts.preset]?.(this.id) ? { thinking: { type: 'disabled' } } : {}),
          messages: req.messages.map((m) => ({
            role: m.role === 'tool' ? 'user' : m.role,
            content: this.contentOf(m),
          })),
          ...(codec.tools.length > 0
            ? {
                tools: codec.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.input },
                })),
                tool_choice: req.toolChoice === 'required' ? 'required' : 'auto',
              }
            : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          // 流式时用量在最后一个分片里，要显式要
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
      });

      // 兼容服务不一定支持流式：没按 SSE 回就当普通响应读，整段回调一次
      const sse = stream && res.ok && (res.headers?.get?.('content-type') ?? '').includes('text/event-stream') && !!res.body;
      const body = sse ? await readStream(res.body!, req.onText, alive, req.onReasoning) : (await res.json()) as ChatResponse;
      if (!res.ok) throw httpError(res.status, body.error?.message ?? res.statusText);
      if (stream && !sse) {
        const m = body.choices?.[0]?.message;
        if (m?.reasoning_content) req.onReasoning?.(m.reasoning_content);
        req.onText?.(m?.content ?? '');
      }

      const choice = body.choices?.[0];
      // 工具参数是字符串，必须 JSON.parse —— 不同供应商的转义策略不同，不能做字符串匹配
      const toolCalls: ModelToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: codec.decode(c.function.name),
        args: safeParse(c.function.arguments),
      }));

      const reasoning = choice?.message?.reasoning_content ?? '';
      return {
        text: choice?.message?.content ?? '',
        ...(reasoning ? { reasoning } : {}),
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
    const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? body.usage?.prompt_cache_hit_tokens ?? 0;
    const base: Usage = { inputTokens: inTok, outputTokens: outTok, cachedInputTokens: cached };
    const p = this.opts.pricing;
    return p ? { ...base, costUSD: (inTok * p.inUSD + outTok * p.outUSD) / 1_000_000 } : base;
  }
}

/**
 * 读 SSE 流，拼成和非流式一样的响应。工具调用的参数是按 `index` 分片到达的字符串，要拼完才能解析。
 * 每收到一段正文就把到目前为止的全文交给 `onText`。
 */
async function readStream(
  body: ReadableStream<Uint8Array>, onText: ((text: string) => void) | undefined, alive: () => void,
  onReasoning?: (text: string) => void,
): Promise<ChatResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  let text = '';
  let reasoning = '';
  let model: string | undefined;
  let finish: string | undefined;
  let usage: ChatResponse['usage'];
  let error: ChatResponse['error'];
  const calls: { id: string; name: string; args: string }[] = [];

  const take = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: {
      model?: string; usage?: ChatResponse['usage']; error?: ChatResponse['error'];
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
    };
    try { chunk = JSON.parse(data); } catch { return; }
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.error) error = chunk.error;
    const c = chunk.choices?.[0];
    if (c?.finish_reason) finish = c.finish_reason;
    for (const tc of c?.delta?.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      const slot = (calls[i] ??= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    const thought = c?.delta?.reasoning_content;
    if (thought) { reasoning += thought; onReasoning?.(reasoning); }
    const piece = c?.delta?.content;
    if (piece) { text += piece; onText?.(text); }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    alive();
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      take(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
  }
  take(buf.trim());

  return {
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    choices: [{
      message: {
        content: text,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length > 0
          ? { tool_calls: calls.filter(Boolean).map((x) => ({ id: x.id, function: { name: x.name, arguments: x.args || '{}' } })) }
          : {}),
      },
      ...(finish ? { finish_reason: finish } : {}),
    }],
  };
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
  // 余额不足：有的家用 429（智谱）、有的用 402（DeepSeek）、有的用 400 —— 先认出来，别报成限流
  const billing = billingError(status, message);
  if (billing) return billing;
  if (status === 401 || status === 403) {
    return new ToolError('FATAL', `鉴权失败（${status}）：${message}`, { hint: '检查 API key' });
  }
  if (status === 429) return new ToolError('RATE_LIMITED', `触发限流：${message}`);
  if (status === 400) return new ToolError('INVALID_ARGS', `请求不合法：${message}`);
  if (status >= 500) return new ToolError('UPSTREAM', `上游 ${status}：${message}`);
  return new ToolError('FATAL', `HTTP ${status}：${message}`);
}
