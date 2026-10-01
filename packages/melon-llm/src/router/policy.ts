import type {
  ChatModel, Message, ModelEntry, ModelRouter, RouteDecision, RouteIntent, Tokenizer,
} from '@melon-ai/core';

export type { ModelEntry };

/**
 * 路由策略。
 * - `auto`：按任务类别的最低档筛、在够档的里挑预估最便宜的（见 auto.ts）。需要宿主给路由规则，没给时所有调用同一类、不限档。
 * - `quality` / `balanced` / `cost`：早先的三档，只看质量分与输入价排序。
 */
export type RouteStrategy = 'auto' | 'quality' | 'balanced' | 'cost';


/** 粗略分词：CJK 按 1 字符≈1 token，其余按 4 字符≈1 token。 */
export class HeuristicTokenizer implements Tokenizer {
  count(text: string): number {
    let cjk = 0;
    for (const ch of text) if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
    return Math.ceil(cjk + (text.length - cjk) / 4);
  }
  countMessages(msgs: readonly Message[]): number {
    return msgs.reduce((n, m) => n + this.count(m.content) + 4, 0);
  }
}

/**
 * 按用途与策略选模型。
 *
 * **只负责「选」，不负责重试。** `select()` 返回候选序列（primary + fallbacks），
 * 真正的重试与熔断由 skills 的工具管线统一执行 ——
 * 不要在系统里养两套重试逻辑（见 architecture.md §4.6）。
 */
export class PolicyRouter implements ModelRouter {
  private readonly unhealthy = new Map<string, number>();

  constructor(
    private readonly entries: readonly ModelEntry[],
    private readonly strategy: RouteStrategy = 'balanced',
    private readonly now: () => number = () => Date.now(),
    /** 标记不健康后多久重新纳入候选。 */
    private readonly cooldownMs = 60_000,
    /** 近期失败率超标的模型（见 `HealthStats`）：排到候选最后，但不剔除。 */
    private readonly demoted: (modelId: string) => boolean = () => false,
  ) {
    if (entries.length === 0) throw new Error('PolicyRouter 至少需要一个模型');
  }

  /** 供应商失败时调用，短期内降权。 */
  markUnhealthy(modelId: string): void {
    this.unhealthy.set(modelId, this.now() + this.cooldownMs);
  }

  /** 候选按优先级排好：策略排序，失败率超标的挪到最后。 */
  rank(intent: RouteIntent): readonly ModelEntry[] {
    const healthy = this.entries.filter(
      (e) => e.enabled !== false && (this.unhealthy.get(e.model.id) ?? 0) <= this.now(),
    );
    // 全都不健康时不要返回空 —— 宁可试一个也别让任务直接死
    const pool = healthy.length > 0 ? healthy : this.entries.filter((e) => e.enabled !== false);
    if (pool.length === 0) throw new Error('没有可用的模型');
    const sorted = [...pool].sort(byStrategy(effectiveStrategy(this.strategy, intent)));
    return [...sorted.filter((e) => !this.demoted(e.model.id)), ...sorted.filter((e) => this.demoted(e.model.id))];
  }

  async select(intent: RouteIntent): Promise<RouteDecision> {
    const ranked = this.rank(intent);
    const primary = ranked[0]!;
    return {
      primary: primary.model,
      fallbacks: ranked.slice(1).map((e) => e.model),
      reason: `${this.strategy}/${intent} → ${primary.model.id}`,
      egress: ranked.map((e) => e.egress),
    };
  }

  tokenizerFor(): Tokenizer {
    return new HeuristicTokenizer();
  }
}

/**
 * 用途会覆盖全局策略。
 *
 * `classify` / `extract` 这类辅助调用**无论如何都走便宜的** ——
 * 让意图分类去用最强的模型是纯粹的浪费，它的判别质量不随模型上限提升。
 */
function effectiveStrategy(base: RouteStrategy, intent: RouteIntent): RouteStrategy {
  if (intent === 'classify' || intent === 'extract') return 'cost';
  if (intent === 'plan' && base === 'balanced') return 'quality';
  return base;
}

function byStrategy(s: RouteStrategy): (a: ModelEntry, b: ModelEntry) => number {
  // auto 由模型池按规则排；直接用 PolicyRouter 时按均衡处理
  if (s === 'auto') return byStrategy('balanced');
  if (s === 'quality') return (a, b) => b.quality - a.quality;
  if (s === 'cost') return (a, b) => a.costUSD - b.costUSD;
  // balanced：质量每高 1 分，愿意多付 1 美元/百万 token
  return (a, b) => (b.quality - b.costUSD) - (a.quality - a.costUSD);
}

/** 只有一个模型时的便捷实现。 */
export function singleModel(model: ChatModel, egress = model.id): ModelRouter {
  return new PolicyRouter([{ model, quality: 1, costUSD: 1, egress }], 'balanced');
}
