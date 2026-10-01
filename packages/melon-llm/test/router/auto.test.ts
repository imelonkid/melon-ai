import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, ModelEntry, ModelPrice, ModelTier, UsageRecord } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { ModelPool, PRICES, UsageStats } from '../../src/index.js';

const FRI_10 = Date.parse('2026-10-02T10:00:00+08:00'); // DeepSeek 高峰
const FRI_13 = Date.parse('2026-10-02T13:00:00+08:00'); // 空闲

function m(id: string, opts: { tools?: boolean; fail?: boolean } = {}): ChatModel {
  return {
    id,
    capabilities: { contextWindow: 1000, maxOutputTokens: 100, tools: opts.tools !== false, jsonSchema: true, promptCache: false },
    async generate() {
      if (opts.fail) throw new ToolError('UPSTREAM', '坏了');
      return { text: id, modelId: id, stopReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
}
const e = (id: string, egress: string, tier: ModelTier | undefined, price: ModelPrice | undefined, opts: { tools?: boolean; fail?: boolean; enabled?: boolean } = {}): ModelEntry => ({
  model: m(id, opts), quality: 5, costUSD: 1, egress, label: egress,
  ...(tier ? { tier } : {}), ...(price ? { price } : {}), ...(opts.enabled === false ? { enabled: false } : {}),
});
const CNY = (input: number, output: number): ModelPrice => ({ input, output, currency: 'CNY' });
const USD = (input: number, output: number): ModelPrice => ({ input, output, currency: 'USD' });

const pool = (entries: ModelEntry[], now: number, rules = () => ({ taskClass: 'chat', minTier: 'standard' as ModelTier })) => {
  const p = new ModelPool(entries, 'auto', { now: () => now, fx: { CNY: 7 } });
  p.route(rules);
  return p;
};
const meta = { purpose: 'plan', taskKind: 'conversation' };

test('自动路由：只在够档的里挑，挑预估最便宜的（不同币种折算后比）', async () => {
  const p = pool([
    e('cheap-basic', 'a', 'basic', CNY(0.1, 0.1)),        // 最便宜但档次不够
    e('std-cny', 'b', 'standard', CNY(1, 4)),
    e('strong-usd', 'c', 'strong', USD(0.5, 2)),         // 折人民币 3.5 / 14，贵
  ], FRI_13);
  assert.equal((await p.select('plan', undefined, { meta })).primary.id, 'std-cny');
  const ex = p.explain({ taskClass: 'chat', minTier: 'standard' });
  assert.deepEqual(ex.ranked.map((c) => [c.key, c.eligible, c.reason ?? '']), [
    ['b/std-cny', true, ''], ['c/strong-usd', true, ''], ['a/cheap-basic', false, '档次不够'],
  ]);
  // 典型用量还没积累够，用初始值：4000 输入 + 600 输出 → (4000 × 1 + 600 × 4) / 百万 = 0.0064 元
  assert.ok(Math.abs(ex.ranked[0]!.estimate!.amount - 0.0064) < 1e-12);
});

test('自动路由：DeepSeek 高峰价翻倍时让位给别家，空闲时再回来', async () => {
  const entries = [e('deepseek-flash', 'deepseek', 'standard', PRICES['deepseek-flash']), e('other', 'x', 'standard', CNY(1.5, 6))];
  assert.equal((await pool(entries, FRI_13).select('plan', undefined, { meta })).primary.id, 'deepseek-flash');
  assert.equal((await pool(entries, FRI_10).select('plan', undefined, { meta })).primary.id, 'other');
  assert.equal(pool(entries, FRI_10).explain({ taskClass: 'chat', minTier: 'standard' }).ranked.find((c) => c.key === 'deepseek/deepseek-flash')!.peak, true);
});

test('自动路由：要工具时只给支持工具的；未定档、未启用的不参与；没价格的排在有价格的后面', async () => {
  const p = pool([
    e('no-tools', 'a', 'standard', CNY(0.1, 0.1), { tools: false }),
    e('untiered', 'b', undefined, CNY(0.1, 0.1)),
    e('off', 'c', 'strong', CNY(0.1, 0.1), { enabled: false }),
    e('unpriced', 'd', 'strong', undefined),
    e('priced', 'f', 'standard', CNY(9, 9)),
  ], FRI_13);
  assert.equal((await p.select('plan', undefined, { meta, needsTools: true })).primary.id, 'priced');
  const reasons = Object.fromEntries(p.explain({ taskClass: 'chat', minTier: 'standard' }, { needsTools: true }).ranked.map((c) => [c.key, c.reason ?? (c.eligible ? 'ok' : '')]));
  assert.deepEqual(reasons, { 'f/priced': 'ok', 'd/unpriced': 'ok', 'a/no-tools': '不支持工具', 'b/untiered': '未定档', 'c/off': '未启用' });
});

test('自动路由：固定的模型排第一（不看档次），失败了照常换下一个', async () => {
  const p = pool([e('pinned', 'a', undefined, undefined, { fail: true }), e('std', 'b', 'standard', CNY(1, 1))], FRI_13,
    () => ({ taskClass: 'chat', minTier: 'standard' as ModelTier, pin: 'a/pinned' }));
  const res = await (await p.select('plan', undefined, { meta })).primary.generate({ messages: [], meta });
  assert.equal(res.modelId, 'std');
  assert.equal(res.failedAttempts?.[0]?.model, 'pinned');
});

test('自动路由：一个够档的都没有时退回到能用的里挑（不让任务直接失败），解释里标出来', async () => {
  const p = pool([e('basic', 'a', 'basic', CNY(1, 1))], FRI_13);
  assert.equal((await p.select('plan', undefined, { meta })).primary.id, 'basic');
  assert.equal(p.explain({ taskClass: 'chat', minTier: 'strong' }).fellBack, true);
});

test('用量统计：典型用量按任务类别取近 7 天平均（不到 5 次用初始值），缓存命中率按模型', () => {
  let now = FRI_13;
  const s = new UsageStats(() => now);
  const rec = (o: Partial<UsageRecord>): UsageRecord => ({
    at: now, calls: 1, purpose: 'plan', egress: 'd', model: 'x', ok: true,
    inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100, cost: 0, currency: 'CNY', priced: true, ms: 100, ...o,
  });
  for (let i = 0; i < 4; i++) s.record(rec({}), 'chat');
  assert.equal(s.typical('chat').inputTokens, 4000, '4 次不够，用初始值');
  s.record(rec({ inputTokens: 6000, cachedInputTokens: 0 }), 'chat');
  assert.equal(s.typical('chat').inputTokens, 2000);
  assert.equal(s.typical('schedule').samples, 0);
  assert.ok(Math.abs(s.cacheRate('d/x') - 2000 / 10000) < 1e-12);
  now += 8 * 86_400_000;
  assert.equal(s.typical('chat').samples, 0, '7 天前的不算');
});

test('用量统计：模型池每记一笔都按这次调用的任务类别更新', async () => {
  const p = pool([e('a', 'v', 'standard', CNY(1, 1))], FRI_13, () => ({ taskClass: 'chat', minTier: 'standard' as ModelTier }));
  for (let i = 0; i < 5; i++) await (await p.select('plan', undefined, { meta })).primary.generate({ messages: [], meta });
  assert.deepEqual(p.stats.typical('chat'), { inputTokens: 100, outputTokens: 10, samples: 5 });
});
