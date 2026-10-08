import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogStore, ChatModel, ModelEntry, ModelListing, ModelPrice, ModelProvider, ModelTier, UsageRecord } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { ModelCatalog, ModelPool } from '../../src/index.js';

/**
 * 分组与优先级、同一家厂商的多个账户：宿主给用户接「自己的 key」和「宿主统一提供的 key」，
 * 自己的优先、宿主的兜底；两个账户互不影响（一个余额不足不连累另一个）。
 */
const NOW = Date.parse('2026-10-02T13:00:00+08:00');
const CNY = (input: number, output: number): ModelPrice => ({ input, output, currency: 'CNY' });

function chat(id: string, behave: () => void = () => {}): ChatModel {
  return {
    id,
    capabilities: { contextWindow: 1000, maxOutputTokens: 100, tools: true, jsonSchema: true, promptCache: false },
    async generate() { behave(); return { text: `${id} 的回答`, modelId: id, stopReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 } }; },
  };
}
const own = (id: string, tier: ModelTier, price: ModelPrice, behave?: () => void): ModelEntry => ({
  model: chat(id, behave), quality: 5, costUSD: 1, egress: 'deepseek', tier, price, group: 'own', priority: 0,
});
const shared = (id: string, tier: ModelTier, price: ModelPrice, behave?: () => void): ModelEntry => ({
  model: chat(id, behave), quality: 5, costUSD: 1, egress: 'deepseek', account: 'shared:deepseek', tier, price, group: 'shared', priority: 1,
});
const meta = { purpose: 'plan' as const, taskKind: 'conversation' };

test('优先级：自己的分组整组排在前面，哪怕宿主提供的更便宜；路由解释里分开（账户不同 key 不同）', async () => {
  const pool = new ModelPool([shared('flash', 'standard', CNY(0.1, 0.1)), own('flash', 'standard', CNY(1, 4))], 'auto', { now: () => NOW });
  pool.route(() => ({ taskClass: 'chat', minTier: 'standard' }));
  const res = await (await pool.select('plan', undefined, { meta })).primary.generate({ messages: [], meta });
  assert.equal(res.group, 'own');
  assert.equal(res.account, undefined, '自己的就是厂商本身，没有单独的账户名');
  assert.deepEqual(pool.explain({ taskClass: 'chat' }).ranked.map((c) => c.key), ['deepseek/flash', 'shared:deepseek/flash']);
});

test('按分组的规则：自己的模型达不到用户要的档次时用宿主的；宿主那组可以单独指定模型', async () => {
  const pool = new ModelPool([own('mini', 'basic', CNY(0.1, 0.1)), shared('flash', 'standard', CNY(1, 4)), shared('pro', 'strong', CNY(4, 12))], 'auto', { now: () => NOW });
  pool.route(() => ({ taskClass: 'chat', byGroup: { own: { minTier: 'standard' }, shared: { pin: 'shared:deepseek/pro' } } }));
  const r1 = await (await pool.select('plan', undefined, { meta })).primary.generate({ messages: [], meta });
  assert.deepEqual([r1.group, r1.modelId], ['shared', 'pro'], '自己的只有基础档，不够；宿主那组固定用 pro');
});

test('兜底：自己的都失败了换宿主的（尝试次数按组各自算）；用量记录和花钱前的检查带上账户与分组', async () => {
  const rows: UsageRecord[] = [];
  const checks: { group?: string; account?: string }[] = [];
  const boom = () => { throw new ToolError('UPSTREAM', '上游 502'); };
  const pool = new ModelPool([own('a', 'standard', CNY(1, 1), boom), own('b', 'standard', CNY(2, 2), boom), shared('flash', 'standard', CNY(1, 4))], 'auto', {
    now: () => NOW, maxAttempts: 2,
    ledger: { record: async (r) => { rows.push(r); }, list: async () => rows, rollup: async () => 0 },
    guard: (c) => { checks.push({ ...(c.group ? { group: c.group } : {}), ...(c.account ? { account: c.account } : {}) }); return null; },
  });
  pool.route(() => ({ taskClass: 'chat', minTier: 'standard' }));
  const res = await (await pool.select('plan', undefined, { meta })).primary.generate({ messages: [], meta });
  assert.deepEqual([res.group, res.account, res.modelId], ['shared', 'shared:deepseek', 'flash'], '自己的两个都失败（用满了 2 次），宿主那组照样能试');
  assert.deepEqual(rows.map((r) => [r.group, r.account ?? '-', r.ok]), [['own', '-', false], ['own', '-', false], ['shared', 'shared:deepseek', true]]);
  assert.deepEqual(checks, [{ group: 'own' }, { group: 'own' }, { group: 'shared', account: 'shared:deepseek' }]);
});

test('账户互不影响：自己的 key 余额不足只暂停自己的账户，宿主提供的同一家照常用', async () => {
  const broke = () => { throw new ToolError('FATAL', 'HTTP 402：Insufficient Balance'); };
  const pool = new ModelPool([own('flash', 'standard', CNY(1, 1), broke), shared('flash', 'standard', CNY(1, 4))], 'auto', { now: () => NOW });
  pool.route(() => ({ taskClass: 'chat', minTier: 'standard' }));
  const res = await (await pool.select('plan', undefined, { meta })).primary.generate({ messages: [], meta });
  assert.equal(res.account, 'shared:deepseek');
  assert.deepEqual(pool.accounts().map((a) => a.egress), ['deepseek'], '暂停的是用户自己的账户（键是账户，不是厂商）');
  const again = await (await pool.select('plan', undefined, { meta })).primary.generate({ messages: [], meta });
  assert.equal(again.account, 'shared:deepseek', '宿主的账户没被连累');
});

test('模型目录：同一家的两个账户各存各的模型列表（key 不同、能用的模型可能不同），条目带上账户、分组、优先级', async () => {
  const rows = new Map<string, ModelListing>();
  const store: CatalogStore = { put: async (l) => { rows.set(l.vendor, l); }, list: async () => [...rows.values()] };
  const provider = (id: string | undefined, group: string, priority: number, listed: string[]): ModelProvider => ({
    vendor: 'deepseek', ...(id ? { id } : {}), group, priority, fingerprint: `${id ?? 'own'}-fp`,
    make(mid?: string): ModelEntry {
      const m = mid ?? 'flash';
      return {
        model: { ...chat(m), async listModels() { return listed; } }, quality: 1, costUSD: 1, egress: 'deepseek',
        tier: 'standard', price: CNY(1, 1),
      };
    },
  });
  const cat = new ModelCatalog({ store, now: () => NOW });
  const changed = cat.setProviders([provider(undefined, 'own', 0, ['flash']), provider('shared:deepseek', 'shared', 1, ['flash', 'pro'])]);
  assert.deepEqual(changed, ['deepseek', 'shared:deepseek']);
  await cat.refresh();
  assert.deepEqual([...rows.keys()].sort(), ['deepseek', 'shared:deepseek']);
  const { entries, catalogs } = cat.expand();
  assert.deepEqual(entries.map((e) => [e.model.id, e.account ?? '-', e.group, e.priority]), [
    ['flash', '-', 'own', 0], ['flash', 'shared:deepseek', 'shared', 1], ['pro', 'shared:deepseek', 'shared', 1],
  ]);
  assert.deepEqual(catalogs.map((c) => [c.vendor, c.account ?? '-', c.group]), [['deepseek', '-', 'own'], ['deepseek', 'shared:deepseek', 'shared']]);
});
