import type {
  ChatModel, Embedder, GenerateRequest, GenerateResult, Message, ModelCapabilities,
  ModelRouter, RouteDecision, RouteIntent, Tokenizer, Usage,
} from '@melon-ai/core';

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

const CAPS: ModelCapabilities = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  tools: true,
  jsonSchema: true,
  promptCache: true,
};

/**
 * 按脚本依次返回预设回复的假模型。
 * 脚本用尽后抛错 —— 静默返回空串会让测试通过但掩盖问题。
 */
export class ScriptedModel implements ChatModel {
  readonly id = 'scripted';
  readonly capabilities = CAPS;
  readonly calls: GenerateRequest[] = [];
  private i = 0;

  constructor(private readonly script: readonly (string | GenerateResult)[]) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const item = this.script[this.i++];
    if (item === undefined) {
      throw new Error(`ScriptedModel 脚本用尽：这是第 ${this.i} 次调用，脚本只有 ${this.script.length} 条`);
    }
    if (typeof item !== 'string') return item;
    return {
      text: item,
      usage: { inputTokens: 10, outputTokens: 5 },
      modelId: this.id,
      stopReason: 'stop',
    };
  }
  get remaining(): number { return this.script.length - this.i; }
  /** 断言用：最后一次请求里，稳定前缀之前有没有混进易变内容。 */
  lastMessages(): readonly Message[] { return this.calls[this.calls.length - 1]?.messages ?? []; }
}

/** 粗略分词：4 字符 ≈ 1 token。测试只需要单调且确定，不需要准。 */
export class FakeTokenizer implements Tokenizer {
  count(text: string): number { return Math.ceil(text.length / 4); }
  countMessages(msgs: readonly Message[]): number {
    return msgs.reduce((n, m) => n + this.count(m.content) + 4, 0);
  }
}

export class StaticRouter implements ModelRouter {
  readonly selected: RouteIntent[] = [];
  constructor(
    private readonly model: ChatModel,
    private readonly fallbacks: readonly ChatModel[] = [],
  ) {}
  async select(intent: RouteIntent): Promise<RouteDecision> {
    this.selected.push(intent);
    return {
      primary: this.model,
      fallbacks: this.fallbacks,
      reason: `static:${intent}`,
      egress: [this.model.id],
    };
  }
  tokenizerFor(): Tokenizer { return new FakeTokenizer(); }
}

/**
 * 确定性 embedding：对文本做哈希后铺到向量上。
 * 相同文本得到相同向量，不同文本几乎必然不同 —— 足够测检索链路的接线是否正确，
 * 但**测不了语义相关性**，语义质量得用真 embedder 评。
 */
export class FakeEmbedder implements Embedder {
  readonly id = 'fake';
  constructor(readonly dims = 16) {}
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) {
        h = (h ^ t.charCodeAt(i)) * 16777619;
        v[i % this.dims] = (v[i % this.dims] ?? 0) + ((h >>> 0) % 1000) / 1000;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
      return v;
    });
  }
}
