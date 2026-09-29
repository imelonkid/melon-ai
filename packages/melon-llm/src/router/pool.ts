import type { ChatModel, ModelEntry, ModelRouter, RouteDecision, RouteIntent, Tokenizer } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { HeuristicTokenizer, PolicyRouter } from './policy.js';
import type { RouteStrategy } from './policy.js';

/**
 * 可热替换的模型池。
 *
 * 宿主改了模型配置（换 key、加一家、改策略）要立刻生效，但**不能重建整个引擎** ——
 * 那会打断在跑的任务。所以可变性收在这一层：规划器持有的是这个池，
 * 池里的路由随时可以换。
 *
 * 一个模型都没有时 `select` 抛出明确的错误，而不是让任务卡住或静默走占位逻辑。
 */
export class ModelPool implements ModelRouter {
  private router: PolicyRouter | null = null;
  private entries: readonly ModelEntry[] = [];
  private readonly fallbackTokenizer = new HeuristicTokenizer();

  constructor(entries: readonly ModelEntry[] = [], private strategy: RouteStrategy = 'balanced') {
    this.set(entries, strategy);
  }

  set(entries: readonly ModelEntry[], strategy: RouteStrategy = this.strategy): void {
    this.entries = entries;
    this.strategy = strategy;
    this.router = entries.length > 0 ? new PolicyRouter(entries, strategy) : null;
  }

  /** 至少有一个可用模型。 */
  get ready(): boolean {
    return this.router !== null;
  }

  get current(): { readonly entries: readonly ModelEntry[]; readonly strategy: RouteStrategy } {
    return { entries: this.entries, strategy: this.strategy };
  }

  async select(intent: RouteIntent): Promise<RouteDecision> {
    if (!this.router) {
      throw new ToolError('FATAL', '没有可用的模型', { retriable: false, hint: '先配置至少一个模型' });
    }
    return this.router.select(intent);
  }

  tokenizerFor(_model: ChatModel): Tokenizer {
    return this.router ? this.router.tokenizerFor() : this.fallbackTokenizer;
  }
}

export interface ModelTestResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly modelId?: string;
  readonly sample?: string;
  readonly costUSD?: number | null;
  readonly code?: string;
  readonly error?: string;
  readonly hint?: string;
}

/**
 * 用一次最便宜的真实调用验证模型可用（key、网络、模型名）。
 *
 * 比「保存后跑个任务再看报错」快得多 —— 宿主的配置页最该有的反馈。
 */
export async function testModel(entry: ModelEntry, timeoutMs = 20_000): Promise<ModelTestResult> {
  const started = Date.now();
  try {
    const res = await entry.model.generate({
      messages: [{ role: 'user', content: '回复「ok」两个字符，不要别的。' }],
      maxOutputTokens: 16,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: true, ms: Date.now() - started, modelId: res.modelId,
      sample: res.text.slice(0, 40), costUSD: res.usage.costUSD ?? null,
    };
  } catch (e) {
    const err = e as { code?: string; message?: string; hint?: string };
    return {
      ok: false, ms: Date.now() - started,
      code: err.code ?? 'FATAL',
      error: String(err.message ?? e),
      ...(err.hint ? { hint: err.hint } : {}),
    };
  }
}
