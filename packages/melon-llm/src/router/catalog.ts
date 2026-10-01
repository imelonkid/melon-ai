import type {
  CatalogModel, CatalogStore, ModelEntry, ModelListing, ModelPrice, ModelProvider, ModelTier, VendorCatalog,
} from '@melon-ai/core';
import { TIER_RANK } from '@melon-ai/core';
import type { PriceBook } from './prices.js';

/**
 * 模型目录：每家厂商最新可用的模型，自动加入路由。
 *
 * 目录 = 这个账号能用的（`/models`）∩ 有官方价格或内置档次的。只在 `/models` 里、没有价格的
 * （embedding、语音、旧型号……）不自动加入，放进「其余可用」给用户手动挑。
 *
 * 档次：用户定的 > 引擎内置（厂商对自家模型的定位）> 按这家各模型的价格高低自动定。
 *
 * 防错：
 * - 拉列表失败：用上次成功的，不清空；
 * - 从没拉成功过（首次启动还没拉到、离线）：只用这家的默认模型和用户手动加的，不至于一个模型都没有；
 *   不从价格文档里猜 —— 文档里常有已弃用的旧别名（DeepSeek 的 deepseek-v4-flash），账号未必能用；
 * - 用户加的模型不在列表里了：标「已下架」，不参与路由（调了也是报错）。
 */
export class ModelCatalog {
  private readonly listings = new Map<string, ModelListing>();
  private providers: readonly ModelProvider[] = [];

  constructor(private readonly opts: {
    readonly store: CatalogStore;
    readonly now: () => number;
    readonly timeoutMs?: number;
  }) {}

  async load(): Promise<void> {
    for (const l of await this.opts.store.list()) this.listings.set(l.vendor, l);
  }

  /** 换厂商（宿主按用户启用了哪几家决定）。返回连接配置变了、该立即重新拉列表的厂商。 */
  setProviders(providers: readonly ModelProvider[]): readonly string[] {
    this.providers = providers;
    return providers
      .filter((p) => p.fingerprint !== undefined && this.listings.get(p.vendor)?.fingerprint !== p.fingerprint)
      .map((p) => p.vendor);
  }

  get vendors(): readonly string[] {
    return this.providers.map((p) => p.vendor);
  }

  /** 上次成功拉列表距今多久；从没成功过为 Infinity。 */
  age(vendor: string): number {
    const at = this.listings.get(vendor)?.lastSuccessAt;
    return at === undefined ? Number.POSITIVE_INFINITY : this.opts.now() - at;
  }

  /** 拉一家或全部的模型列表。一家失败不影响别家；适配器不支持列模型的跳过。 */
  async refresh(vendor?: string): Promise<readonly ModelListing[]> {
    const out: ModelListing[] = [];
    for (const p of this.providers.filter((x) => !vendor || x.vendor === vendor)) {
      const r = await this.refreshOne(p);
      if (r) out.push(r);
    }
    return out;
  }

  private async refreshOne(p: ModelProvider): Promise<ModelListing | null> {
    const prev = this.listings.get(p.vendor);
    const at = this.opts.now();
    let next: ModelListing;
    try {
      const model = p.make().model;
      if (!model.listModels) return null;
      const ids = [...new Set(await model.listModels(AbortSignal.timeout(this.opts.timeoutMs ?? 20_000)))];
      next = { vendor: p.vendor, at, ok: true, ids, lastSuccessAt: at, ...(p.fingerprint !== undefined ? { fingerprint: p.fingerprint } : {}) };
    } catch (e) {
      // 换了 key 之后失败：上次的列表是旧账号的，不能再当成这个账号能用的
      const same = prev && prev.fingerprint === p.fingerprint;
      next = {
        vendor: p.vendor, at, ok: false, error: e instanceof Error ? e.message : String(e),
        ...(same && prev.ids ? { ids: prev.ids } : {}),
        ...(same && prev.lastSuccessAt !== undefined ? { lastSuccessAt: prev.lastSuccessAt } : {}),
        ...(p.fingerprint !== undefined ? { fingerprint: p.fingerprint } : {}),
      };
    }
    await this.opts.store.put(next);
    this.listings.set(p.vendor, next);
    return next;
  }

  /** 展开成路由用的模型条目，以及给宿主看的目录。 */
  expand(book?: PriceBook | null): { readonly entries: readonly ModelEntry[]; readonly catalogs: readonly VendorCatalog[] } {
    const entries: ModelEntry[] = [];
    const catalogs: VendorCatalog[] = [];
    for (const p of this.providers) {
      const r = expandOne(p, this.listings.get(p.vendor), book ?? null);
      entries.push(...r.entries);
      catalogs.push(r.catalog);
    }
    return { entries, catalogs };
  }
}

type Built = { id: string; entry: ModelEntry; official: boolean };

function expandOne(p: ModelProvider, listing: ModelListing | undefined, book: PriceBook | null): { entries: ModelEntry[]; catalog: VendorCatalog } {
  const ids = listing?.ids ?? null;
  const overrides = p.overrides ?? {};
  const synced = book?.pricesOf(p.vendor) ?? {};
  let fallbackId: string | undefined;
  try { fallbackId = p.make().model.id; } catch { /* 默认模型也造不出来：只剩用户加的 */ }

  // 候选：拉到的列表；没拉成功过时只用默认模型（不从价格文档里猜：文档里有已弃用的旧别名，账号未必能用）。再加上用户改过的
  const candidates = new Set<string>([
    ...(ids ?? (fallbackId ? [fallbackId] : [])),
    ...Object.keys(overrides),
  ]);
  const built: Built[] = [];
  const others: string[] = [];
  for (const id of candidates) {
    let entry: ModelEntry;
    try { entry = p.make(id); } catch { if (ids?.includes(id)) others.push(id); continue; }
    if (book) entry = book.effective(entry);
    const official = !!synced[id] || (entry.priceSource !== 'manual' && !!entry.price) || !!entry.tier;
    if (!official && !overrides[id]?.added) { if (ids?.includes(id)) others.push(id); continue; }
    built.push({ id, entry, official });
  }

  // 按价格自动定档：只在这家有价格、引擎没内置档次的模型之间比
  const autoTier = priceTiers(built.filter((b) => !b.entry.tier && b.entry.price).map((b) => ({ id: b.id, price: b.entry.price! })));

  const models: CatalogModel[] = [];
  const entries: ModelEntry[] = [];
  for (const b of built) {
    const o = overrides[b.id] ?? {};
    const price: ModelPrice | undefined = o.price ?? b.entry.price;
    const priceSource = o.price ? 'manual' as const : b.entry.price ? (b.entry.priceSource ?? 'builtin') : undefined;
    let tier: ModelTier | undefined;
    let tierBy: CatalogModel['tierBy'];
    if (o.tier !== undefined) { tier = o.tier ?? undefined; tierBy = o.tier ? 'user' : 'none'; }
    else if (b.entry.tier) { tier = b.entry.tier; tierBy = 'builtin'; }
    else if (autoTier[b.id]) { tier = autoTier[b.id]; tierBy = 'price'; }
    else tierBy = 'none';
    const available = ids === null ? null : ids.includes(b.id);
    const inactive = o.enabled === false ? 'off' as const : available === false ? 'gone' as const : undefined;
    models.push({
      id: b.id, available, official: b.official, ...(tier ? { tier } : {}), tierBy,
      ...(price ? { price } : {}), ...(priceSource ? { priceSource } : {}),
      tools: b.entry.model.capabilities.tools, added: !!o.added, active: !inactive, ...(inactive ? { inactive } : {}),
    });
    if (inactive) continue;
    const { tier: _t, price: _p, priceSource: _s, ...rest } = b.entry;
    entries.push({
      ...rest, ...(p.label && !rest.label ? { label: p.label } : {}),
      ...(tier ? { tier } : {}), ...(price ? { price } : {}), ...(priceSource ? { priceSource } : {}),
    });
  }
  models.sort((a, b) => (b.tier ? TIER_RANK[b.tier] : 0) - (a.tier ? TIER_RANK[a.tier] : 0) || a.id.localeCompare(b.id));
  return {
    entries,
    catalog: {
      vendor: p.vendor, ...(p.label ? { label: p.label } : {}), ...(listing ? { listing } : {}),
      models, others: others.sort(),
    },
  };
}

/** 一百万 token 的综合价：输入按三份、输出按一份算（对话里输入远多于输出）。 */
const blended = (p: ModelPrice): number => p.input * 0.75 + p.output * 0.25;

/** 名字里带这些的是厂商的轻量款 / 旗舰款：自动定档时不越过它的定位。 */
const LIGHT = /(mini|nano|lite|flash|air|haiku|turbo|small|tiny)/i;
const FLAGSHIP = /(max|pro|opus|ultra|plus|large)/i;

/**
 * 按价格在这家里的位置定档：只有一个就是标准；两个时贵的是强、便宜的是标准；
 * 三个以上，最便宜的三分之一是基础、最贵的三分之一是强。名字表明是轻量款的不定成强，旗舰款的不定成基础。
 */
export function priceTiers(items: readonly { id: string; price: ModelPrice }[]): Record<string, ModelTier> {
  const sorted = [...items].sort((a, b) => blended(a.price) - blended(b.price));
  const n = sorted.length;
  const out: Record<string, ModelTier> = {};
  sorted.forEach((x, i) => {
    let t: ModelTier;
    if (n === 1) t = 'standard';
    else if (n === 2) t = i === 1 && blended(sorted[1]!.price) > blended(sorted[0]!.price) ? 'strong' : 'standard';
    else t = i < n / 3 ? 'basic' : i >= n - n / 3 ? 'strong' : 'standard';
    if (t === 'strong' && LIGHT.test(x.id)) t = 'standard';
    if (t === 'basic' && FLAGSHIP.test(x.id)) t = 'standard';
    out[x.id] = t;
  });
  return out;
}
