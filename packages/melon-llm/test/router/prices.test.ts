import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, ModelEntry, ModelPrice, PriceSheet, PriceStore, PriceSync } from '@melon-ai/core';
import { ModelPool, PriceBook } from '../../src/index.js';

const store = (): PriceStore & { rows: Map<string, PriceSync> } => {
  const rows = new Map<string, PriceSync>();
  return { rows, put: async (s) => { rows.set(s.vendor, s); }, get: async (v) => rows.get(v) ?? null, list: async () => [...rows.values()] };
};
const P = (input: number, output: number): ModelPrice => ({ input, output, currency: 'CNY' });
const source = (sheets: (PriceSheet | Error)[]) => {
  let i = 0;
  return { vendor: 'deepseek', url: 'https://doc', fetch: async () => { const s = sheets[Math.min(i++, sheets.length - 1)]!; if (s instanceof Error) throw s; return s; } };
};

test('价格同步：新模型与小幅调价直接生效；变化超过 5 倍的等确认；第一次也和内置价比', async () => {
  const st = store();
  const book = new PriceBook({ store: st, now: () => 1000, builtin: (_v, m) => (m === 'flash' ? P(1, 4) : undefined) });
  book.setSources([source([{ prices: { flash: P(10, 4), pro: P(4.5, 13.5) } }])]);
  const [r] = await book.sync();
  assert.equal(r!.ok, true);
  // flash 输入 1 → 10：10 倍，等确认；pro 是新模型，直接生效
  assert.deepEqual(r!.pending.map((p) => [p.model, p.ratio]), [['flash', 10]]);
  assert.deepEqual(Object.keys(r!.prices), ['pro']);
  assert.equal(book.price('deepseek', 'flash'), undefined, '确认前不用新价（内置价照用）');
  assert.equal(await book.confirm('deepseek', 'flash'), true);
  assert.deepEqual(book.price('deepseek', 'flash'), P(10, 4));
  assert.equal(st.rows.get('deepseek')!.pending.length, 0, '确认的结果也存档');
});

test('价格同步：失败或什么都没读出来时保留上次的价格，记下原因；这次没出现的模型保留旧价', async () => {
  const book = new PriceBook({ store: store(), now: () => 1000 });
  book.setSources([source([{ prices: { a: P(1, 1), b: P(2, 2) } }, new Error('HTTP 503'), { prices: {} }, { prices: { a: P(1.2, 1) } }])]);
  await book.sync();
  const [fail] = await book.sync();
  assert.deepEqual([fail!.ok, fail!.error, Object.keys(fail!.prices).length, fail!.lastSuccessAt], [false, 'HTTP 503', 2, 1000]);
  const [empty] = await book.sync();
  assert.equal(empty!.ok, false);
  assert.match(empty!.error!, /格式可能变了/);
  const [ok] = await book.sync();
  assert.deepEqual(ok!.prices, { a: P(1.2, 1), b: P(2, 2) });
  assert.deepEqual(ok!.changed.map((c) => c.model), ['a']);
});

test('价格同步：模型池选模型和记账都用同步来的价格；手填的不被覆盖', async () => {
  const m = (id: string): ChatModel => ({
    id, capabilities: { contextWindow: 1, maxOutputTokens: 1, tools: true, jsonSchema: true, promptCache: false },
    async generate() { return { text: id, modelId: id, stopReason: 'stop', usage: { inputTokens: 1_000_000, outputTokens: 0 } }; },
  });
  const e = (id: string, price?: ModelPrice, manual = false): ModelEntry => ({
    model: m(id), quality: 1, costUSD: 1, egress: 'deepseek', tier: 'standard',
    ...(price ? { price, priceSource: manual ? 'manual' as const : 'builtin' as const } : {}),
  });
  const book = new PriceBook({ store: store(), now: () => Date.parse('2026-10-03T13:00:00+08:00') });
  book.setSources([source([{ prices: { a: P(5, 5), b: P(0.5, 0.5), c: P(0.1, 0.1) } }])]);
  await book.sync();
  const pool = new ModelPool([e('a', P(5, 5)), e('b', P(9, 9)), e('c', P(3, 3), true)], 'auto', { now: () => Date.parse('2026-10-03T13:00:00+08:00') });
  pool.pricing(book);
  // b 内置 9（贵）→ 同步来的 0.5；c 手填 3，同步的 0.1 不覆盖 → b 最便宜
  const ex = pool.explain({ taskClass: 'x' });
  assert.deepEqual(ex.ranked.map((c) => c.key), ['deepseek/b', 'deepseek/c', 'deepseek/a']);
  const res = await (await pool.select('plan', undefined, { meta: { purpose: 'plan' } })).primary.generate({ messages: [] });
  assert.equal(res.usage.cost?.amount, 0.5, '记账用同步来的价格');
});
