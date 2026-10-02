import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, GenerateRequest, ModelEntry, ModelPrice, UsageRecord } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { HealthStats, ModelPool, PRICES, costOf, isPeak, summarizeUsage } from '../../src/index.js';

/** 北京时间 2026-10-02 周五：10:00 是高峰，13:00 是空闲。 */
const FRI_10 = Date.parse('2026-10-02T10:00:00+08:00');
const FRI_13 = Date.parse('2026-10-02T13:00:00+08:00');
const SAT_10 = Date.parse('2026-10-03T10:00:00+08:00');

test('价格：DeepSeek 工作日 9–12、14–18 点是高峰，周末不是', () => {
  const p = PRICES['deepseek-flash']!;
  assert.equal(isPeak(p, FRI_10), true);
  assert.equal(isPeak(p, FRI_13), false);
  assert.equal(isPeak(p, SAT_10), false);
});

test('价格：命中缓存的输入按缓存价，高峰翻倍', () => {
  const p = PRICES['deepseek-flash']!;
  const u = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 };
  // 空闲：60 万 × 1 + 40 万 × 0.02 + 10 万 × 4 = 0.6 + 0.008 + 0.4
  assert.ok(Math.abs(costOf(p, u, FRI_13) - 1.008) < 1e-9);
  assert.ok(Math.abs(costOf(p, u, FRI_10) - 2.016) < 1e-9);
});

const PRICE: ModelPrice = { input: 2, output: 8, currency: 'CNY' };

function model(id: string, behave: (req: GenerateRequest) => Promise<void> | void): ChatModel {
  return {
    id,
    capabilities: { contextWindow: 1000, maxOutputTokens: 100, tools: true, jsonSchema: true, promptCache: false },
    async generate(req) {
      await behave(req);
      return { text: `${id} 的回答`, modelId: id, stopReason: 'stop', usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 } };
    },
  };
}
const entry = (id: string, m: ChatModel, price?: ModelPrice): ModelEntry => ({
  model: m, quality: id === 'a' ? 9 : 5, costUSD: 1, egress: `vendor-${id}`, ...(price ? { price } : {}),
});
const ledger = () => {
  const rows: UsageRecord[] = [];
  return { rows, record: async (r: UsageRecord) => { rows.push(r); }, list: async () => rows, rollup: async () => 0 };
};
const meta = { taskId: 't1' as never, agentId: 'default', taskKind: 'conversation', trigger: 'manual', purpose: 'plan' as const };

test('计量：每次问模型记一笔，费用按价格算并折成美元；没价格的记「未计价」', async () => {
  const l = ledger();
  const pool = new ModelPool([entry('a', model('a', () => {}), PRICE)], 'quality', { ledger: l, fx: { CNY: 8 }, now: () => FRI_13 });
  const res = await (await pool.select('plan')).primary.generate({ messages: [], meta });
  // 1000 × 2 + 500 × 8 = 6000 / 百万 = 0.006 元 = 0.00075 美元（汇率 8）
  assert.ok(Math.abs(res.usage.cost!.amount - 0.006) < 1e-12);
  assert.ok(Math.abs(res.usage.costUSD! - 0.00075) < 1e-12);
  assert.equal(res.egress, 'vendor-a');
  assert.deepEqual([l.rows[0]!.ok, l.rows[0]!.priced, l.rows[0]!.taskId, l.rows[0]!.attempt], [true, true, 't1', 1]);

  const l2 = ledger();
  const unpriced = new ModelPool([entry('b', model('b', () => {}))], 'quality', { ledger: l2 });
  const r2 = await (await unpriced.select('plan')).primary.generate({ messages: [], meta });
  assert.equal(r2.usage.costUSD, undefined);
  assert.deepEqual([l2.rows[0]!.priced, l2.rows[0]!.cost], [false, 0]);
});

test('计量：没说为谁问的调用（连接测试）不进账本', async () => {
  const l = ledger();
  const pool = new ModelPool([entry('a', model('a', () => {}), PRICE)], 'quality', { ledger: l });
  await (await pool.select('plan')).primary.generate({ messages: [] });
  assert.equal(l.rows.length, 0);
});

test('换模型：首选出错就换下一个，两次都记账；先吐出的半截内容通知调用方收起', async () => {
  const l = ledger();
  const a = model('a', (req) => { req.onText?.('说到一半'); throw new ToolError('UPSTREAM', '上游 502'); });
  const pool = new ModelPool([entry('a', a, PRICE), entry('b', model('b', () => {}), PRICE)], 'quality', { ledger: l });
  let retried = 0;
  const res = await (await pool.select('plan')).primary.generate({ messages: [], meta, onRetry: () => { retried++; } });
  assert.equal(res.text, 'b 的回答');
  assert.equal(res.egress, 'vendor-b');
  assert.deepEqual(res.failedAttempts, [{ egress: 'vendor-a', model: 'a', errorCode: 'UPSTREAM' }]);
  assert.equal(retried, 1);
  assert.deepEqual(l.rows.map((r) => [r.model, r.ok, r.attempt, r.errorCode]), [['a', false, 1, 'UPSTREAM'], ['b', true, 2, undefined]]);
});

test('换模型：最多试 maxAttempts 个；调用方取消时不换', async () => {
  const bad = (id: string) => model(id, () => { throw new ToolError('UPSTREAM', '坏了'); });
  const three = [entry('a', bad('a')), entry('b', bad('b')), entry('c', model('c', () => {}))];
  const l = ledger();
  await assert.rejects(async () => (await new ModelPool(three, 'quality', { ledger: l, maxAttempts: 2 }).select('plan')).primary.generate({ messages: [], meta }));
  assert.equal(l.rows.length, 2);

  const ctl = new AbortController();
  const cancel = model('a', () => { ctl.abort(); throw new ToolError('UPSTREAM', '被取消'); });
  const l2 = ledger();
  const pool = new ModelPool([entry('a', cancel), entry('b', model('b', () => {}))], 'quality', { ledger: l2 });
  await assert.rejects(async () => (await pool.select('plan')).primary.generate({ messages: [], meta, signal: ctl.signal }));
  assert.equal(l2.rows.length, 1, '取消了就不该再去问下一家');
});

test('降权：近一小时失败率超过 20%（至少 5 次）的排到最后，样本少不判', async () => {
  let now = 1_000_000;
  const h = new HealthStats(() => now);
  for (let i = 0; i < 4; i++) h.record('a', false);
  assert.equal(h.demoted('a'), false, '只有 4 次，不判');
  h.record('a', true);
  assert.equal(h.demoted('a'), true, '5 次里 4 次失败');
  now += 3_600_001;
  assert.equal(h.demoted('a'), false, '一小时前的不算');

  const pool = new ModelPool([entry('a', model('a', () => {})), entry('b', model('b', () => {}))], 'quality');
  assert.equal((await pool.select('plan')).primary.id, 'a');
  for (let i = 0; i < 5; i++) pool.health.record('a', false);
  assert.equal((await pool.select('plan')).primary.id, 'b');
});

test('汇总：按小时分格（空格也在）、按模型与任务类型分组，费用折成人民币，没价格的单独数', () => {
  const base = Date.parse('2026-10-02T09:00:00+08:00');
  const rec = (o: Partial<UsageRecord>): UsageRecord => ({
    at: base, calls: 1, purpose: 'plan', egress: 'deepseek', model: 'deepseek-flash', ok: true,
    inputTokens: 100, cachedInputTokens: 50, outputTokens: 10, cost: 0.5, currency: 'CNY', priced: true, ms: 100,
    taskKind: 'conversation', trigger: 'manual', ...o,
  });
  const s = summarizeUsage([
    rec({}),
    rec({ at: base + 2 * 3_600_000 + 60_000, egress: 'anthropic', model: 'claude-opus-5', cost: 1, currency: 'USD', trigger: 'schedule' }),
    rec({ at: base + 2 * 3_600_000 + 120_000, ok: false, cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
    rec({ egress: 'aliyun', model: 'qwen-max', priced: false, cost: 0 }),
  ], { from: base, to: base + 4 * 3_600_000, bucket: 'hour', timeZone: 'Asia/Shanghai', currency: 'CNY', fx: { CNY: 7 } });
  assert.equal(s.buckets.length, 4);
  assert.deepEqual(s.buckets.map((b) => b.calls), [2, 0, 2, 0]);
  assert.equal(s.calls, 4);
  assert.equal(s.failed, 1);
  assert.equal(s.unpricedCalls, 1);
  assert.ok(Math.abs(s.cost - 7.5) < 1e-9, '0.5 元 + 1 美元 × 7');
  assert.equal(s.cacheHitRate, 150 / 300);
  assert.equal(s.groups.model[0]!.key, 'anthropic/claude-opus-5');
  assert.deepEqual(s.groups.trigger.map((g) => g.key).sort(), ['manual', 'schedule']);
  assert.equal(s.groups.custom.length, 0);
  const c = summarizeUsage([rec({}), rec({ trigger: 'schedule' })], {
    from: base, to: base + 3_600_000, classify: (r) => (r.trigger === 'schedule' ? '定时任务' : '对话'),
  });
  assert.deepEqual(c.groups.custom.map((g) => [g.key, g.calls]).sort(), [['定时任务', 1], ['对话', 1]]);
});

test('汇总：按次收费的工具单独成组，不混进模型组；费用照样算进总数', () => {
  const r = (o: Partial<UsageRecord>): UsageRecord => ({
    at: 1, calls: 1, purpose: 'plan', egress: 'deepseek', model: 'deepseek-flash', ok: true,
    inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, cost: 0.01, currency: 'CNY', priced: true, ms: 1, ...o,
  });
  const s = summarizeUsage([r({}), r({ purpose: 'tool', egress: 'bocha', model: 'web.search', cost: 0.036, inputTokens: 0, outputTokens: 0 })], { from: 0, to: 10, currency: 'CNY' });
  assert.deepEqual(s.groups.model.map((g) => g.key), ['deepseek/deepseek-flash']);
  assert.deepEqual(s.groups.tool.map((g) => [g.key, g.calls]), [['bocha/web.search', 1]]);
  assert.ok(Math.abs(s.cost - 0.046) < 1e-12);
});

test('余额不足：同一家的其余模型不再试，直接换下一家；这一家暂停使用，状态给宿主看；测试通过或改配置后恢复', async () => {
  const { isAccountError } = await import('../../src/index.js');
  let zhipuCalls = 0;
  // 智谱的余额不足是 429 + 「余额不足或无可用资源包」—— 看着像限流，其实是账户的事
  const broke = (id: string) => model(id, () => { zhipuCalls += 1; throw new ToolError('RATE_LIMITED', '触发限流：余额不足或无可用资源包,请充值。'); });
  const z1: ModelEntry = { model: broke('glm-5'), quality: 9, costUSD: 1, egress: 'zhipu' };
  const z2: ModelEntry = { model: broke('glm-5.1'), quality: 8, costUSD: 1, egress: 'zhipu' };
  const ds: ModelEntry = { model: model('deepseek-flash', () => {}), quality: 5, costUSD: 1, egress: 'deepseek' };
  let now = FRI_13;
  const pool = new ModelPool([z1, z2, ds], 'quality', { now: () => now, maxAttempts: 2 });

  const res = await (await pool.select('plan')).primary.generate({ messages: [], meta });
  assert.equal(res.egress, 'deepseek', '换到了另一家');
  assert.equal(zhipuCalls, 1, '同一家的另一个模型不再试（同一个账户，一样没余额）');

  const st = pool.accounts();
  assert.equal(st.length, 1);
  assert.equal(st[0]!.egress, 'zhipu');
  assert.equal(st[0]!.reason, 'billing');
  assert.match(st[0]!.message, /余额不足/);

  // 暂停期间：排序时直接跳过这一家
  await (await pool.select('plan')).primary.generate({ messages: [], meta });
  assert.equal(zhipuCalls, 1, '暂停中的不再去碰');

  // 只剩这一家时也照样试（不至于一个模型都没有）
  const only = new ModelPool([z1], 'quality', { now: () => now });
  only.markAccount('zhipu', 'billing', '余额不足');
  await assert.rejects((await only.select('plan')).primary.generate({ messages: [], meta }), /余额不足/);

  // 暂停到期后再试一次
  now += 31 * 60_000;
  assert.equal(pool.accounts().length, 0, '过了暂停期');
  // 宿主改了配置 / 测试通过：立即恢复
  pool.markAccount('zhipu', 'billing', '余额不足');
  pool.clearAccount('zhipu');
  assert.equal(pool.accounts().length, 0);

  assert.equal(isAccountError(new ToolError('FATAL', 'HTTP 402：Insufficient Balance')), 'billing');
  assert.equal(isAccountError(new ToolError('RATE_LIMITED', '触发限流：You exceeded your current quota, please check your plan and billing details')), 'billing');
  assert.equal(isAccountError(new ToolError('FATAL', 'Anthropic 400：Your credit balance is too low to access the Anthropic API')), 'billing');
  assert.equal(isAccountError(new ToolError('FATAL', '鉴权失败（401）：invalid api key')), 'auth');
  assert.equal(isAccountError(new ToolError('RATE_LIMITED', '触发限流：Rate limit reached for requests')), null, '真正的限流不算');
});
