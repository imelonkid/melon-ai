import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogStore, ChatModel, ModelEntry, ModelListing, ModelPrice, ModelProvider, ModelTier, PriceStore, PriceSync } from '@melon-ai/core';
import { ModelCatalog, PriceBook, priceTiers } from '../../src/index.js';

const CNY = (input: number, output: number): ModelPrice => ({ input, output, currency: 'CNY' });
const catalogStore = (): CatalogStore & { rows: Map<string, ModelListing> } => {
  const rows = new Map<string, ModelListing>();
  return { rows, put: async (l) => { rows.set(l.vendor, l); }, list: async () => [...rows.values()] };
};
const priceStore = (): PriceStore => {
  const rows = new Map<string, PriceSync>();
  return { put: async (s) => { rows.set(s.vendor, s); }, get: async (v) => rows.get(v) ?? null, list: async () => [...rows.values()] };
};

/** 一家厂商：/models 返回 `listed`（或抛错）；内置表里有的带档次和价格。 */
function vendor(opts: {
  listed: () => string[];
  builtin?: Record<string, { tier?: ModelTier; price?: ModelPrice }>;
  overrides?: ModelProvider['overrides'];
  fingerprint?: string;
}): ModelProvider & { calls: number } {
  const p = {
    vendor: 'ds', label: 'DeepSeek', calls: 0, fingerprint: opts.fingerprint,
    overrides: opts.overrides,
    make(id?: string): ModelEntry {
      const mid = id ?? 'flash';
      const model: ChatModel = {
        id: mid,
        capabilities: { contextWindow: 1, maxOutputTokens: 1, tools: true, jsonSchema: true, promptCache: false },
        async generate() { throw new Error('不该调用'); },
        async listModels() { p.calls++; return opts.listed(); },
      };
      const b = opts.builtin?.[mid] ?? {};
      return { model, quality: 1, costUSD: 1, egress: 'ds', label: 'DeepSeek', ...(b.tier ? { tier: b.tier } : {}), ...(b.price ? { price: b.price } : {}) };
    },
  };
  return p as ModelProvider & { calls: number };
}

const bookWith = async (prices: Record<string, ModelPrice>): Promise<PriceBook> => {
  const book = new PriceBook({ store: priceStore(), now: () => 1 });
  book.setSources([{ vendor: 'ds', url: 'u', fetch: async () => ({ prices }) }]);
  await book.sync();
  return book;
};

test('模型目录：账号能用的 ∩ 有官方价格或内置档次的自动加入；其余可用的给下拉框', async () => {
  const cat = new ModelCatalog({ store: catalogStore(), now: () => 1000 });
  await cat.load();
  cat.setProviders([vendor({
    listed: () => ['flash', 'pro', 'max', 'embed-v3', 'reasoner'],
    builtin: { flash: { tier: 'standard', price: CNY(1, 4) } },
  })]);
  await cat.refresh();
  // 官方价格文档：pro、max 有价格（max 不在内置档次表里 → 按价格定档）；old 下架了
  const book = await bookWith({ pro: CNY(4.5, 13.5), max: CNY(20, 60), old: CNY(1, 1) });
  const { entries, catalogs } = cat.expand(book);
  assert.deepEqual(entries.map((x) => x.model.id).sort(), ['flash', 'max', 'pro']);
  const c = catalogs[0]!;
  assert.deepEqual(c.others, ['embed-v3', 'reasoner']);
  const byId = Object.fromEntries(c.models.map((m) => [m.id, m]));
  assert.deepEqual([byId.flash!.tier, byId.flash!.tierBy], ['standard', 'builtin']);
  // pro、max 都没有内置档次：两个里贵的是强档，便宜的是标准；名字带 max 不会定成基础
  assert.deepEqual([byId.pro!.tier, byId.pro!.tierBy, byId.max!.tier], ['standard', 'price', 'strong']);
  assert.equal(byId.pro!.priceSource, 'synced');
  assert.equal(byId.old, undefined, '官方列表里没有的不加入');
  assert.equal(c.models[0]!.id, 'max', '按档次从强到弱');
});

test('模型目录：用户的改动优先 —— 关掉、改档次、手填价格、手动加；加的模型下架了标出来、不参与路由', async () => {
  let listed = ['flash', 'reasoner'];
  const cat = new ModelCatalog({ store: catalogStore(), now: () => 1000 });
  cat.setProviders([vendor({
    listed: () => listed,
    builtin: { flash: { tier: 'standard', price: CNY(1, 4) } },
    overrides: { flash: { tier: 'strong', price: CNY(2, 2) }, reasoner: { added: true, tier: 'strong' } },
  })]);
  await cat.refresh();
  let m = Object.fromEntries(cat.expand().catalogs[0]!.models.map((x) => [x.id, x]));
  assert.deepEqual([m.flash!.tier, m.flash!.tierBy, m.flash!.priceSource], ['strong', 'user', 'manual']);
  assert.deepEqual([m.reasoner!.added, m.reasoner!.active, m.reasoner!.official], [true, true, false]);
  listed = ['flash'];
  await cat.refresh();
  m = Object.fromEntries(cat.expand().catalogs[0]!.models.map((x) => [x.id, x]));
  assert.deepEqual([m.reasoner!.active, m.reasoner!.inactive, m.reasoner!.available], [false, 'gone', false]);
  assert.deepEqual(cat.expand().entries.map((x) => x.model.id), ['flash']);

  cat.setProviders([vendor({ listed: () => listed, builtin: { flash: { tier: 'standard' } }, overrides: { flash: { enabled: false } } })]);
  m = Object.fromEntries(cat.expand().catalogs[0]!.models.map((x) => [x.id, x]));
  assert.equal(m.flash!.inactive, 'off');
  assert.equal(cat.expand().entries.length, 0);
});

test('模型目录：拉列表失败用上次的；从没拉成功过时用有官方价格的 + 默认模型；换了 key 立即重拉、旧列表作废', async () => {
  const st = catalogStore();
  let fail = false;
  const mk = (fingerprint: string) => vendor({ fingerprint, listed: () => { if (fail) throw new Error('HTTP 401'); return ['flash', 'pro']; }, builtin: { flash: { tier: 'standard' }, pro: { tier: 'strong' } } });

  // 离线首次：没列表，用默认模型 + 有官方价格的
  const offline = new ModelCatalog({ store: catalogStore(), now: () => 1 });
  offline.setProviders([vendor({ listed: () => { throw new Error('offline'); }, builtin: { flash: { tier: 'standard' } } })]);
  await offline.refresh();
  const book = await bookWith({ pro: CNY(4.5, 13.5) });
  assert.deepEqual(offline.expand(book).entries.map((x) => x.model.id).sort(), ['flash', 'pro']);
  assert.equal(offline.expand(book).catalogs[0]!.models[0]!.available, null);

  const cat = new ModelCatalog({ store: st, now: () => 1000 });
  assert.deepEqual(cat.setProviders([mk('k1')]), ['ds'], '没拉过：要拉');
  await cat.refresh();
  fail = true;
  const [r] = await cat.refresh();
  assert.deepEqual([r!.ok, r!.error, r!.ids, r!.lastSuccessAt], [false, 'HTTP 401', ['flash', 'pro'], 1000]);

  // 重启：读回存档，指纹没变不用拉
  const again = new ModelCatalog({ store: st, now: () => 2000 });
  await again.load();
  assert.deepEqual(again.setProviders([mk('k1')]), []);
  assert.deepEqual(again.expand().entries.map((x) => x.model.id).sort(), ['flash', 'pro']);
  // 换了 key：要重拉；拉失败时不再沿用旧账号的列表
  assert.deepEqual(again.setProviders([mk('k2')]), ['ds']);
  const [r2] = await again.refresh();
  assert.equal(r2!.ids, undefined);
});

test('按价格定档：一个是标准；三个以上最便宜的三分之一基础、最贵的三分之一强；轻量款不定成强', () => {
  assert.deepEqual(priceTiers([{ id: 'a', price: CNY(1, 1) }]), { a: 'standard' });
  assert.deepEqual(priceTiers([
    { id: 'a', price: CNY(1, 1) }, { id: 'b', price: CNY(2, 2) }, { id: 'c', price: CNY(3, 3) },
    { id: 'd', price: CNY(4, 4) }, { id: 'e-flash', price: CNY(9, 9) }, { id: 'f', price: CNY(5, 5) },
  ]), { a: 'basic', b: 'basic', c: 'standard', d: 'standard', f: 'strong', 'e-flash': 'standard' });
});
