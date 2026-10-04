import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminStore, SpendEntry } from '@melon-ai/core';
import { openSqliteAdminStore } from '../../src/sqlite/index.js';
import { InMemoryAdminStore } from '../../src/memory/index.js';

const e = (principal: string, at: number, amount: number, counted = true): SpendEntry => ({
  principal, at, amount, currency: 'CNY', counted, kind: 'model', vendor: 'deepseek', model: 'm', ok: true,
});

async function conformance(store: AdminStore) {
  assert.equal(await store.getSetting('site'), undefined);
  await store.setSetting('site', { siteName: '后台' });
  assert.deepEqual(await store.getSetting('site'), { siteName: '后台' });
  await store.setPolicy('u1', { mode: 'custom', amounts: { day: 5 } });
  await store.setPolicy('u2', { mode: 'unlimited' });
  assert.deepEqual(await store.listPolicies(), { u1: { mode: 'custom', amounts: { day: 5 } }, u2: { mode: 'unlimited' } });
  await store.setPolicy('u2', { mode: 'default' });
  assert.equal(await store.getPolicy('u2'), null, '回到通用策略就是没有单独的');
  await store.recordSpend(e('u1', 100, 1));
  await store.recordSpend(e('u1', 200, 2, false));
  await store.recordSpend(e('u2', 300, 4));
  assert.equal(await store.sumCounted('u1', 0), 1, '不算额度的不进合计');
  assert.equal(await store.sumCounted('u2', 301), 0);
  assert.deepEqual((await store.listSpend({ from: 0, countedOnly: true })).map((x) => x.principal), ['u1', 'u2']);
  assert.deepEqual((await store.listSpend({ from: 150, principal: 'u1' })).map((x) => x.counted), [false]);
  await store.purgeSpend(250);
  assert.equal((await store.listSpend({ from: 0 })).length, 1);
}

test('后台存储：SQLite 版（设置、额度策略、花费流水、清理），重开后数据还在', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'melon-admin-')), 'admin.db');
  const s = openSqliteAdminStore({ file });
  await conformance(s);
  s.close();
  const again = openSqliteAdminStore({ file });
  assert.deepEqual(await again.getSetting('site'), { siteName: '后台' });
  again.close();
});

test('后台存储：内存版行为一致', async () => {
  await conformance(new InMemoryAdminStore());
});
