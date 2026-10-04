import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { UsageRecord } from '@melon-ai/core';
import { InMemoryAdminStore } from '@melon-ai/store';
import { createAdmin, ADMIN_HTML_FOR_TEST } from './helpers.js';

/** 北京时间 2026-10-04 20:00。 */
const NOW = Date.parse('2026-10-04T20:00:00+08:00');
const HOUR = 3_600_000;

const rec = (at: number, cost: number, o: Partial<UsageRecord> = {}): UsageRecord => ({
  at, calls: 1, purpose: 'plan', egress: 'deepseek', model: 'deepseek-flash', ok: true,
  inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost, currency: 'CNY', priced: true, ms: 10, ...o,
});

function setup(now = NOW) {
  const store = new InMemoryAdminStore();
  let t = now;
  const principals = [
    { id: 'u1', name: '小林', username: 'lin', role: '管理员', status: 'active' as const },
    { id: 'u2', name: 'bob', status: 'active' as const },
  ];
  const statuses: string[] = [];
  const admin = createAdmin({
    store, now: () => t,
    principals: { list: () => principals, setStatus: (id, s) => { statuses.push(`${id}:${s}`); } },
    auth: { verify: (u, p) => (u === 'lin' && p === 'pw-1234567' ? { name: '小林' } : null) },
    siteName: 'Melon 后台',
  });
  return { store, admin, statuses, advance: (ms: number) => { t += ms; } };
}

test('额度：没设过用默认（每天 2、每 5 小时 0.8）；通用策略改了所有走通用的人立即生效', async () => {
  const { admin } = setup();
  assert.deepEqual(await admin.quota.limits('u1'), { day: 2, '5h': 0.8 });
  await admin.quota.setDefaultAmounts({ day: 5, '5h': 'x' as never });
  assert.deepEqual(await admin.quota.limits('u1'), { day: 5, '5h': 0.8 }, '不合法的金额保持原值');
});

test('额度：单独策略覆盖通用（缺的时间窗按通用）；不限没有限额；回到通用删掉单独的', async () => {
  const { admin, store } = setup();
  await admin.quota.setPolicy('u2', { mode: 'custom', amounts: { day: 10 } });
  assert.deepEqual(await admin.quota.limits('u2'), { day: 10, '5h': 0.8 });
  await admin.quota.setPolicy('u2', { mode: 'unlimited' });
  assert.equal(await admin.quota.limits('u2'), null);
  await admin.quota.setPolicy('u2', { mode: 'default' });
  assert.equal(await store.getPolicy('u2'), null);
});

test('计量：算额度的花费超了就拒，原因带金额和恢复时间；不算额度的照样记、不扣额度；不限的永远放行', async () => {
  const { admin, advance } = setup();
  const m = admin.meter('u2', ({ vendor }) => vendor === 'deepseek');
  m.onUsage(rec(NOW - 6 * HOUR, 1.5));
  m.onUsage(rec(NOW - 1 * HOUR, 0.6));
  m.onUsage(rec(NOW - 1 * HOUR, 9, { egress: 'own-vendor' }));
  await new Promise((r) => setImmediate(r));
  const s = await admin.status('u2');
  assert.deepEqual(s.windows.map((w) => [w.id, w.used]), [['day', 2.1], ['5h', 0.6]]);
  const d = await m.spendGuard({ kind: 'model', vendor: 'deepseek' });
  assert.match(d?.reason ?? '', /今天的额度（¥2）用完了，明天 0 点恢复/);
  assert.equal(d?.resumeAt, Date.parse('2026-10-05T00:00:00+08:00'));
  assert.equal(await m.spendGuard({ kind: 'model', vendor: 'own-vendor' }), null, '不算额度的不拦');
  await admin.quota.setPolicy('u2', { mode: 'unlimited' });
  assert.equal(await m.spendGuard({ kind: 'model', vendor: 'deepseek' }), null);
  advance(0);
});

test('滚动窗口：用完时说什么时候恢复（最早的几笔滑出去之后）', async () => {
  const { admin } = setup();
  await admin.quota.setPolicy('u1', { mode: 'custom', amounts: { day: 100, '5h': 1 } });
  const m = admin.meter('u1');
  m.onUsage(rec(NOW - 4 * HOUR, 0.7));
  m.onUsage(rec(NOW - 2 * HOUR, 0.5));
  await new Promise((r) => setImmediate(r));
  const d = await m.spendGuard({ kind: 'model', vendor: 'deepseek' });
  assert.equal(d?.resumeAt, NOW + HOUR, '4 小时前那笔滑出去后只剩 0.5');
  assert.match(d!.reason, /这 5 小时的额度（¥1）用完了，21:00 左右恢复/);
});

test('计量：美元按汇率折成人民币；套餐内的不算钱', async () => {
  const { admin } = setup();
  await admin.record('u1', rec(NOW, 1, { currency: 'USD' }), true);
  await admin.record('u1', rec(NOW, 3, { billing: 'plan' }), true);
  assert.equal((await admin.status('u1')).windows[0]!.used, 7.2);
});

test('概览与按天汇总：今天的花费 / 调用 / 失败、额度用完的人、最近 7 天每天一行', async () => {
  const { admin } = setup();
  await admin.record('u2', rec(NOW - HOUR, 2.5), true);
  await admin.record('u2', rec(NOW - HOUR, 0, { ok: false }), true);
  await admin.record('u1', rec(NOW - 2 * 86_400_000, 1, { purpose: 'tool', egress: 'bocha' }), false);
  const o = await admin.overview();
  assert.deepEqual(o.today, { counted: 2.5, total: 2.5, calls: 2, tools: 0, failed: 1 });
  assert.deepEqual(o.users, { total: 2, active: 2, exhausted: 1 });
  assert.equal(o.days.length, 7);
  assert.equal(o.days[4]!.day, '2026-10-02');
  assert.deepEqual([o.days[4]!.total, o.days[4]!.counted, o.days[4]!.tools], [1, 0, 1]);
  assert.equal(o.top[0]!.id, 'u2');
});

test('站点设置：网站名称默认取宿主给的，管理员改了以改的为准；名称去空白、限长', async () => {
  const { admin } = setup();
  assert.deepEqual(await admin.settings(), { siteName: 'Melon 后台', theme: 'system' });
  const s = await admin.setSettings({ siteName: '  我的   后台  ', theme: 'dark' });
  assert.deepEqual(s, { siteName: '我的 后台', theme: 'dark' });
  assert.equal((await admin.setSettings({ siteName: '   ' })).siteName, '我的 后台', '空名字不覆盖');
});

test('页面源文件和嵌进代码的一致（改了 ui.html 要跑 scripts/embed-ui.mjs）', () => {
  assert.equal(ADMIN_HTML_FOR_TEST, readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8'));
});
