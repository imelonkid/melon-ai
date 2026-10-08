import type { SpendGuard,
  CallMeta, ChatModel, ModelEntry, ModelRouter, ModelTier, RouteContext, RouteDecision, RouteIntent, Tokenizer, UsageLedger, UsageRecord,
} from '@melon-ai/core';
import { ToolError, accountOf } from '@melon-ai/core';
import { HeuristicTokenizer, PolicyRouter } from './policy.js';
import type { RouteStrategy } from './policy.js';
import { AccountStatus, FailoverModel, HealthStats } from './meter.js';
import type { AccountProblem, FxRates } from './meter.js';
import { QuotaCounter, UsageStats, rankAuto } from './auto.js';
import type { PriceBook } from './prices.js';
import type { RouteExplanation, RoutingRule, RoutingRules } from './auto.js';

export interface MeteringOptions {
  /** 用量账本。不给就不记账（失败换模型照样生效）。 */
  readonly ledger?: UsageLedger;
  /** 汇率：1 美元 = 多少该币种。任务的费用预算按美元算，人民币计价的模型要折算。 */
  readonly fx?: FxRates;
  /** 一次调用最多试几个模型（含首选）。默认 2。 */
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly onLedgerError?: (e: unknown) => void;
  /** 花钱前的检查（宿主的额度），见 `SpendGuard`。 */
  readonly guard?: SpendGuard;
}

/** 账本里的一条 → 路由规则要的调用信息（预热统计时按当时的规则归类）。 */
const metaOf = (r: UsageRecord): CallMeta => ({
  purpose: r.purpose,
  ...(r.taskId !== undefined ? { taskId: r.taskId } : {}),
  ...(r.agentId !== undefined ? { agentId: r.agentId } : {}),
  ...(r.taskKind !== undefined ? { taskKind: r.taskKind } : {}),
  ...(r.trigger !== undefined ? { trigger: r.trigger } : {}),
});

/** 没给路由规则时：所有调用同一类、不限档。 */
const NO_RULES: RoutingRules = () => ({ taskClass: 'default' });

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
  private metering: MeteringOptions = {};
  /** 各模型近一小时的成败。换模型配置时不清空 —— 出错的模型换个配置还是那个模型。 */
  readonly health: HealthStats;
  /** 近 7 天的实际用量（每类任务的典型用量、每个模型的缓存命中率与耗时），自动路由预估花费用。 */
  readonly stats: UsageStats;
  /** 套餐额度：按厂商数近一个月成功的请求。 */
  readonly quota: QuotaCounter;
  /** 各家账户：余额不足、key 失效的暂停使用。 */
  private readonly account: AccountStatus;
  private rules: RoutingRules = NO_RULES;
  /** 同步来的官方价格。没有时用条目自带的（内置或手填）。 */
  private book: PriceBook | null = null;

  /** 接上价格簿：选模型和记账都用同步来的价格（手填的不被覆盖）。 */
  pricing(book: PriceBook): void {
    this.book = book;
  }

  /** 生效中的模型条目：套上同步来的价格。 */
  private live(): readonly ModelEntry[] {
    const all = this.book ? this.entries.map((e) => this.book!.effective(e)) : this.entries;
    return this.usable(all);
  }

  /** 去掉账户暂停的厂商；全都暂停了就都留着（总比没有模型强，也许已经充值了）。 */
  private usable<T extends ModelEntry>(list: readonly T[]): readonly T[] {
    const ok = list.filter((e) => !this.account.down(accountOf(e)));
    return ok.length > 0 ? ok : list;
  }

  /** 账户出了问题的厂商（余额不足、key 失效；按账户记，键是 `ModelEntry.account ?? egress`）：宿主的资源页据此提示用户去充值或换 key。 */
  accounts(): readonly AccountProblem[] {
    return this.account.list();
  }

  /** 宿主知道的账户问题（比如连接测试时发现的）。 */
  markAccount(egress: string, reason: 'billing' | 'auth', message: string): void {
    this.account.mark(egress, reason, message);
  }

  /** 用户改了配置、测试通过：立即恢复这一家（不传就全部恢复）。 */
  clearAccount(egress?: string): void {
    this.account.clear(egress);
  }

  constructor(entries: readonly ModelEntry[] = [], private strategy: RouteStrategy = 'balanced', metering: MeteringOptions = {}) {
    this.metering = metering;
    this.health = new HealthStats(metering.now);
    this.stats = new UsageStats(metering.now);
    this.quota = new QuotaCounter(metering.now);
    this.account = new AccountStatus(metering.now);
    this.set(entries, strategy);
  }

  /** 宿主的路由规则（任务类别、最低档、固定模型）。策略为 `auto` 时生效。 */
  route(rules: RoutingRules): void {
    this.rules = rules;
  }

  /** 用账本里的历史记录预热：近一小时的成败、近 7 天的用量统计。 */
  seed(records: readonly UsageRecord[]): void {
    const now = (this.metering.now ?? (() => Date.now()))();
    // 工具的记录（搜索按次计费）不算模型的成败与用量
    const models = records.filter((r) => r.purpose !== 'tool');
    this.health.seed(models.filter((r) => r.at > now - this.health.windowMs));
    for (const r of models) {
      this.stats.record(r, this.rules(metaOf(r)).taskClass);
      if (r.billing === 'plan' && r.ok) for (let k = 0; k < r.calls; k++) this.quota.add(r.account ?? r.egress, r.at);
    }
  }

  /**
   * 某类任务现在会选谁、为什么、预估多少钱。给宿主的路由页用，不发请求。
   * 直接给规则（不经宿主的分类函数）：路由页按类别逐个问。
   */
  explain(rule: RoutingRule, ctx: RouteContext = {}): RouteExplanation {
    const m = this.metering;
    return rankAuto({
      entries: this.live(), rule, ctx, stats: this.stats, health: this.health, quota: this.quota,
      now: (m.now ?? (() => Date.now()))(), ...(m.fx ? { fx: m.fx } : {}),
    }).explanation;
  }

  /** 接上账本、汇率等。可以在创建之后再给（账本要等存储就绪）。 */
  meter(opts: MeteringOptions): void {
    this.metering = { ...this.metering, ...opts };
  }

  set(entries: readonly ModelEntry[], strategy: RouteStrategy = this.strategy): void {
    this.entries = entries;
    this.strategy = strategy;
    this.router = entries.length > 0
      ? new PolicyRouter(entries, strategy, () => Date.now(), 60_000, (id) => this.health.demoted(id))
      : null;
  }

  /** 至少有一个可用模型。 */
  get ready(): boolean {
    return this.router !== null;
  }

  get current(): { readonly entries: readonly ModelEntry[]; readonly strategy: RouteStrategy } {
    return { entries: this.entries, strategy: this.strategy };
  }

  async select(intent: RouteIntent, _signal?: AbortSignal, ctx: RouteContext = {}): Promise<RouteDecision> {
    if (!this.router) {
      throw new ToolError('FATAL', '没有可用的模型', { retriable: false, hint: '先配置至少一个模型' });
    }
    const m = this.metering;
    const rule = this.rules(ctx.meta);
    const ranked = this.strategy === 'auto'
      ? rankAuto({
          entries: this.live(), rule, ctx, stats: this.stats, health: this.health, quota: this.quota,
          now: (m.now ?? (() => Date.now()))(), ...(m.fx ? { fx: m.fx } : {}),
        }).ranked
      // 旧的三档：要工具时同样只给支持工具的
      : this.usable(this.router.rank(intent)).map((e) => (this.book ? this.book.effective(e) : e))
        .filter((e, _i, all) => !ctx.needsTools || e.model.capabilities.tools || all.every((x) => !x.model.capabilities.tools))
        .filter((e) => !ctx.needsVision || e.model.capabilities.vision);
    if (ranked.length === 0 && ctx.needsVision) {
      // 能看图的都没启用，或者都暂停了（余额不足）：说清楚，别让看不了图的模型去猜
      const paused = this.account.list().length > 0 && this.entries.some((e) => e.model.capabilities.vision && this.account.down(accountOf(e)));
      throw new ToolError('FATAL', paused
        ? '能看图的模型现在用不了（账户余额不足或 key 失效），这次没法看图'
        : '当前启用的模型都看不了图', { retriable: false, hint: paused ? '去模型设置里给这家充值，或启用另一家能看图的' : '启用一个能看图的模型（如智谱 GLM-5.3-Flash、通义 Qwen-VL、Claude、GPT-4o）' });
    }
    if (ranked.length === 0) {
      throw new ToolError('FATAL', ctx.needsTools ? '没有支持工具调用的模型' : '没有可用的模型', { retriable: false, hint: '在模型配置里启用一个模型' });
    }
    // 首选是一个会自己换下一个的模型：规划器照常调 primary.generate，失败换模型、记账都在里面
    const primary = new FailoverModel(ranked, {
      health: this.health,
      now: m.now ?? (() => Date.now()),
      maxAttempts: m.maxAttempts ?? 2,
      accounts: this.account,
      ...(m.ledger ? { ledger: m.ledger } : {}),
      ...(m.fx ? { fx: m.fx } : {}),
      ...(m.onLedgerError ? { onLedgerError: m.onLedgerError } : {}),
      ...(m.guard ? { guard: m.guard } : {}),
      // 每记一笔顺带更新路由的用量统计（按这次调用所属的任务类别）
      onRecord: (r) => {
        this.stats.record(r, rule.taskClass);
        if (r.billing === 'plan' && r.ok) this.quota.add(r.account ?? r.egress, r.at);
      },
    });
    return {
      primary,
      fallbacks: ranked.slice(1).map((e) => e.model),
      reason: `${this.strategy}/${intent} → ${ranked[0]!.model.id}`,
      egress: ranked.map((e) => e.egress),
    };
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
