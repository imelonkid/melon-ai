import type { ModelEntry, ModelPrice, PriceChange, PriceSource, PriceStore, PriceSync } from '@melon-ai/core';

/**
 * 价格簿：从各家官方文档同步来的价格。引擎只管机制（拉取、校验、存档、生效），怎么读文档在插件里。
 *
 * 防错（官方文档是给人看的，格式随时会变）：
 * - 拉取或解析失败、一个价格都没读出来：保留上一次的，记下失败原因 —— 不清空；
 * - 上一次有、这次没读到的模型：保留上一次的价格；
 * - 单个模型的价格变化超过 `maxRatio` 倍：先不生效，等用户确认（解析错位常把价格读成别的列）；
 * - 第一次同步也要比：和引擎内置的价格比，内置也没有的直接生效。
 *
 * 优先级：用户手填 > 同步来的 > 内置。手填的模型同步不覆盖（见 `effective`）。
 */
export class PriceBook {
  private readonly current = new Map<string, PriceSync>();
  private sources: readonly PriceSource[] = [];

  constructor(private readonly opts: {
    readonly store: PriceStore;
    readonly now: () => number;
    /** 第一次同步时拿来对比的内置价格。 */
    readonly builtin?: (vendor: string, model: string) => ModelPrice | undefined;
    readonly maxRatio?: number;
    readonly timeoutMs?: number;
  }) {}

  setSources(sources: readonly PriceSource[]): void {
    this.sources = sources;
  }

  /** 启动时读回上次的结果。 */
  async load(): Promise<void> {
    for (const s of await this.opts.store.list()) this.current.set(s.vendor, s);
  }

  /** 同步来的、生效中的价格。没有时 undefined。 */
  price(vendor: string, model: string): ModelPrice | undefined {
    return this.current.get(vendor)?.prices[model];
  }

  /** 模型条目套上同步来的价格（手填的不动）。 */
  effective(e: ModelEntry): ModelEntry {
    if (e.priceSource === 'manual') return e;
    const p = this.price(e.egress, e.model.id);
    return p ? { ...e, price: p, priceSource: 'synced' } : e;
  }

  /** 每家最新的同步结果（只列当前配置的来源）。 */
  status(): readonly (PriceSync | { readonly vendor: string; readonly url: string; readonly never: true })[] {
    return this.sources.map((s) => this.current.get(s.vendor) ?? { vendor: s.vendor, url: s.url, never: true as const });
  }

  /** 上次成功同步距今多久；从没成功过为 Infinity。 */
  age(vendor: string): number {
    const at = this.current.get(vendor)?.lastSuccessAt;
    return at === undefined ? Number.POSITIVE_INFINITY : this.opts.now() - at;
  }

  /** 同步一家或全部。一家失败不影响别家。 */
  async sync(vendor?: string): Promise<readonly PriceSync[]> {
    const out: PriceSync[] = [];
    for (const s of this.sources.filter((x) => !vendor || x.vendor === vendor)) out.push(await this.syncOne(s));
    return out;
  }

  private async syncOne(src: PriceSource): Promise<PriceSync> {
    const prev = this.current.get(src.vendor);
    const prevPrices = prev?.prices ?? {};
    const at = this.opts.now();
    let next: PriceSync;
    try {
      const sheet = await src.fetch(AbortSignal.timeout(this.opts.timeoutMs ?? 30_000));
      const entries = Object.entries(sheet.prices).filter(([, p]) => validPrice(p));
      if (entries.length === 0) throw new Error('没有读出任何价格（官方文档的格式可能变了）');
      const prices: Record<string, ModelPrice> = { ...prevPrices };
      const changed: PriceChange[] = [];
      // 还在等确认的：这次没再出现同样的变化就作废，出现了就留着
      const pending: PriceChange[] = [];
      for (const [model, to] of entries) {
        const from = prevPrices[model] ?? this.opts.builtin?.(src.vendor, model);
        if (from && samePrice(from, to)) { prices[model] = from; continue; }
        const ratio = from ? ratioOf(from, to) : 1;
        if (from && ratio > (this.opts.maxRatio ?? 5)) {
          pending.push({ model, from, to, ratio });
          if (prevPrices[model] === undefined) delete prices[model];
          continue;
        }
        prices[model] = to;
        changed.push({ model, ...(from ? { from } : {}), to, ratio });
      }
      next = {
        vendor: src.vendor, url: src.url, at, ok: true, prices, changed, pending, lastSuccessAt: at,
        ...(sheet.notes?.length ? { notes: sheet.notes } : {}),
      };
    } catch (e) {
      next = {
        vendor: src.vendor, url: src.url, at, ok: false, error: e instanceof Error ? e.message : String(e),
        prices: prevPrices, changed: [], pending: prev?.pending ?? [],
        ...(prev?.lastSuccessAt !== undefined ? { lastSuccessAt: prev.lastSuccessAt } : {}),
        ...(prev?.notes ? { notes: prev.notes } : {}),
      };
    }
    await this.opts.store.put(next);
    this.current.set(src.vendor, next);
    return next;
  }

  /** 用户确认一个变化很大的价格：生效。 */
  async confirm(vendor: string, model: string): Promise<boolean> {
    return this.resolve(vendor, model, true);
  }

  /** 用户不认这个变化：丢掉，继续用旧价（下次同步还一样的话会再问）。 */
  async dismiss(vendor: string, model: string): Promise<boolean> {
    return this.resolve(vendor, model, false);
  }

  private async resolve(vendor: string, model: string, accept: boolean): Promise<boolean> {
    const cur = this.current.get(vendor);
    const hit = cur?.pending.find((p) => p.model === model);
    if (!cur || !hit) return false;
    const next: PriceSync = {
      ...cur,
      prices: accept ? { ...cur.prices, [model]: hit.to } : cur.prices,
      pending: cur.pending.filter((p) => p.model !== model),
      changed: accept ? [...cur.changed, hit] : cur.changed,
    };
    await this.opts.store.put(next);
    this.current.set(vendor, next);
    return true;
  }
}

const validPrice = (p: ModelPrice): boolean => ['CNY', 'USD'].includes(p.currency)
  && [p.input, p.output].every((n) => Number.isFinite(n) && n >= 0);

function samePrice(a: ModelPrice, b: ModelPrice): boolean {
  return a.currency === b.currency && a.input === b.input && a.output === b.output && (a.cachedInput ?? a.input) === (b.cachedInput ?? b.input)
    && JSON.stringify(a.peak ?? null) === JSON.stringify(b.peak ?? null);
}

/** 输入、输出里变化最大的倍数。免费 ↔ 收费算无穷大（必须确认）；换了币种不比（直接生效）。 */
function ratioOf(a: ModelPrice, b: ModelPrice): number {
  if (a.currency !== b.currency) return 1;
  const r = (x: number, y: number): number => (x === y ? 1 : x === 0 || y === 0 ? Number.POSITIVE_INFINITY : Math.max(x / y, y / x));
  return Math.max(r(a.input, b.input), r(a.output, b.output));
}
