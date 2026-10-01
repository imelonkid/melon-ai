import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory, Schedule, StoreBundle } from '@melon-ai/core';
import { asMemoryId, asScheduleId, asTaskId } from '@melon-ai/core';
import { memoryStorage } from '../../src/index.js';
import { openSqliteStores } from '../../src/sqlite/index.js';

/**
 * ── 整套存储的一致性测试 ──
 *
 * 内存存储是引擎的默认存储，宿主可能先用它、再换 SQLite。
 * 两者语义不一致的话，「开发时一切正常、上了持久化就出错」—— 所以同一组断言跑两遍。
 */
type Bundle = StoreBundle & { idempotency: { get(k: string): Promise<unknown>; put(k: string, r: never, ttl: number): Promise<void> } };
interface Impl { readonly name: string; readonly make: (now: () => number) => Bundle; }

const IMPLS: Impl[] = [
  { name: '内存', make: (now) => memoryStorage({ now, dims: 3 }) as unknown as Bundle },
  {
    name: 'SQLite',
    make: (now) => openSqliteStores({ file: join(mkdtempSync(join(tmpdir(), 'melon-bundle-')), 't.db'), now, dims: 3 }) as unknown as Bundle,
  },
];

const T1 = asTaskId('t1');
const T2 = asTaskId('t2');

const mem = (id: string, over: Partial<Memory> = {}): Memory => ({
  id: asMemoryId(id), scope: 'user', kind: 'preference', subject: 'report.format',
  statement: '周报用要点列表', confidence: 0.9, importance: 0.5,
  provenance: { taskId: T1, eventSeq: 1 }, createdAt: 0, lastUsedAt: 0, useCount: 0,
  ...over,
});

const sched = (id: string, over: Partial<Schedule> = {}): Schedule => ({
  id: asScheduleId(id), title: '', template: { agentId: 'a1' as never, kind: 'automation', goal: 'g' },
  rule: { kind: 'once', at: 100 }, catchUp: 'skip', status: 'active', nextFireAt: 100,
  lastFiredAt: null, lastTaskId: null, fireCount: 0, createdAt: 0, updatedAt: 0, supersededBy: null,
  ...over,
});

for (const impl of IMPLS) {
  test(`[${impl.name}] 价格同步：每家一条最新的，覆盖写，能列出`, async () => {
    const b = impl.make(() => 0);
    const sync = (at: number) => ({ vendor: 'deepseek', url: 'u', at, ok: true, prices: { a: { input: at, output: 1, currency: 'CNY' as const } }, changed: [], pending: [] });
    await b.prices.put(sync(1));
    await b.prices.put(sync(2));
    await b.prices.put({ ...sync(3), vendor: 'zhipu' });
    assert.equal((await b.prices.get('deepseek'))!.prices.a!.input, 2);
    assert.deepEqual((await b.prices.list()).map((s) => s.vendor).sort(), ['deepseek', 'zhipu']);
    assert.equal(await b.prices.get('nope'), null);
  });

  test(`[${impl.name}] 模型目录：每家一条最新的模型列表，覆盖写，能列出`, async () => {
    const b = impl.make(() => 0);
    await b.catalog.put({ vendor: 'deepseek', at: 1, ok: true, ids: ['a'], lastSuccessAt: 1, fingerprint: 'f' });
    await b.catalog.put({ vendor: 'deepseek', at: 2, ok: false, error: 'HTTP 401', ids: ['a'], lastSuccessAt: 1, fingerprint: 'f' });
    await b.catalog.put({ vendor: 'zhipu', at: 3, ok: true, ids: [] });
    const all = await b.catalog.list();
    assert.deepEqual(all.map((l) => [l.vendor, l.at, l.error ?? null]), [['deepseek', 2, 'HTTP 401'], ['zhipu', 3, null]]);
  });

  test(`[${impl.name}] 用量账本：按时间范围列出；过保留期的明细按天汇总（维度保留、任务 id 丢掉），只汇总一次`, async () => {
    const b = impl.make(() => 0);
    const DAY = 86_400_000;
    const rec = (at: number, o: Record<string, unknown> = {}) => ({
      at, calls: 1, taskId: T1, agentId: 'a', taskKind: 'conversation', trigger: 'manual', purpose: 'plan',
      egress: 'deepseek', model: 'deepseek-flash', ok: true, attempt: 1,
      inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, cost: 0.5, currency: 'CNY' as const, priced: true, ms: 200, ...o,
    });
    await b.usage.record(rec(DAY + 1));
    await b.usage.record(rec(DAY + 2, { taskId: T2 }));
    await b.usage.record(rec(DAY + 3, { ok: false, errorCode: 'UPSTREAM', cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }));
    await b.usage.record(rec(3 * DAY));
    assert.equal((await b.usage.list({ from: DAY, to: 2 * DAY })).length, 3);

    assert.equal(await b.usage.rollup(2 * DAY), 3);
    const rows = await b.usage.list({ from: 0, to: 10 * DAY });
    const ok = rows.find((r) => r.at === DAY && r.ok)!;
    assert.deepEqual([ok.calls, ok.inputTokens, ok.cost, ok.ms, ok.taskId, ok.taskKind], [2, 200, 1, 400, undefined, 'conversation']);
    assert.ok(rows.some((r) => r.at === DAY && !r.ok && r.errorCode === 'UPSTREAM'));
    assert.ok(rows.some((r) => r.at === 3 * DAY && r.taskId === T1), '保留期内的明细不动');
    // 已汇总的不再汇总：再跑一次数不变
    assert.equal(await b.usage.rollup(2 * DAY), 0);
    assert.equal((await b.usage.list({ from: 0, to: 10 * DAY })).length, rows.length);
  });

  test(`[${impl.name}] 定时：到期才返回，removed 默认不列出，supersede 留版本链`, async () => {
    const b = impl.make(() => 0);
    await b.schedules.put(sched('s1', { nextFireAt: 100 }));
    await b.schedules.put(sched('s2', { nextFireAt: 500, createdAt: 1 }));
    await b.schedules.put(sched('s3', { status: 'paused', nextFireAt: 50, createdAt: 2 }));
    assert.deepEqual((await b.schedules.listDue(200, 10)).map((s) => s.id), ['s1']);
    await b.schedules.supersede(asScheduleId('s1'), asScheduleId('s2'));
    const old = await b.schedules.get(asScheduleId('s1'));
    assert.equal(old?.status, 'removed');
    assert.equal(old?.supersededBy, 's2');
    assert.deepEqual((await b.schedules.list()).map((s) => s.id).sort(), ['s2', 's3']);
    assert.deepEqual((await b.schedules.list(undefined, 'paused')).map((s) => s.id), ['s3']);
    await b.close();
  });

  test(`[${impl.name}] 片段：原文按顺序追加、按 1 起的闭区间读回`, async () => {
    const b = impl.make(() => 0);
    const ep = await b.episodes.open(T1, 0);
    for (const text of ['a', 'b', 'c']) await b.episodes.append(ep, { kind: 'user', text } as never);
    assert.deepEqual((await b.episodes.readEntries(ep)).map((e) => (e as { text: string }).text), ['a', 'b', 'c']);
    assert.deepEqual((await b.episodes.readEntries(ep, { from: 2, to: 3 })).map((e) => (e as { text: string }).text), ['b', 'c']);
    await b.episodes.close(ep, 5);
    assert.equal((await b.episodes.get(ep))?.state, 'closed');
    assert.equal((await b.episodes.list(T1)).length, 1);
    await b.close();
  });

  test(`[${impl.name}] 记忆：关键词命中、被替代的默认不召回、按任务遗忘连向量一起删`, async () => {
    const b = impl.make(() => 0);
    await b.memories.put(mem('m1', { statement: '周报用要点列表' }));
    await b.memories.put(mem('m2', { statement: '周报发给产品组', provenance: { taskId: T2, eventSeq: 1 } }));
    await b.memories.put(mem('m3', { statement: '喜欢早上开会', subject: 'meeting.time' }));
    await b.vectors.upsert('m1', new Float32Array([1, 0, 0]));

    const hit = await b.memories.search({ scope: 'user', text: '周报', limit: 10 });
    assert.deepEqual(hit.map((s) => s.item.id).sort(), ['m1', 'm2']);

    await b.memories.supersede(asMemoryId('m1'), asMemoryId('m2'));
    assert.deepEqual((await b.memories.search({ scope: 'user', text: '周报', limit: 10 })).map((s) => s.item.id), ['m2']);
    assert.equal((await b.memories.search({ scope: 'user', text: '周报', limit: 10, activeOnly: false })).length, 2);
    assert.deepEqual((await b.memories.findBySubject('user', 'report.format', 'preference')).map((m) => m.id), ['m2']);

    await b.memories.touch([asMemoryId('m3')], 9);
    assert.equal((await b.memories.get(asMemoryId('m3')))?.useCount, 1);

    assert.equal(await b.memories.forgetByTask(T1), 2); // m1、m3 都来自 T1
    assert.equal(await b.memories.get(asMemoryId('m1')), null);
    assert.equal((await b.vectors.query(new Float32Array([1, 0, 0]), 5)).length, 0, '向量必须一起删，否则删了还能被召回');
    await b.close();
  });

  test(`[${impl.name}] 幂等：过期后不再命中`, async () => {
    let now = 1000;
    const b = impl.make(() => now);
    await b.idempotency.put('k', { ok: true, summary: 's', metrics: { ms: 1, bytes: 0, retries: 0 } } as never, 100);
    assert.notEqual(await b.idempotency.get('k'), null);
    now = 1200;
    assert.equal(await b.idempotency.get('k'), null);
    await b.close();
  });

  test(`[${impl.name}] artifact：按任务列出、按区间读；privacy 清理留墓碑`, async () => {
    const b = impl.make(() => 0);
    const ref = await b.artifacts.put(T1, 'hello world', { mime: 'text/plain', summary: 's' });
    assert.equal(new TextDecoder().decode(await b.artifacts.read(ref, { offset: 6, length: 5 })), 'world');
    assert.equal((await b.artifacts.listByTask(T1)).length, 1);

    const dry = await b.purger.purge({ refs: [{ kind: 'artifact', ref }], motive: 'privacy', reason: 'r', dryRun: true });
    assert.equal(dry.tombstones.length, 1);
    assert.notEqual(await b.artifacts.stat(ref), null, 'dryRun 不能真删');

    const res = await b.purger.purge({ refs: [{ kind: 'artifact', ref }], motive: 'privacy', reason: 'r' });
    assert.equal(res.tombstones[0]?.reason, 'privacy-optout');
    assert.equal(await b.artifacts.stat(ref), null);
    await b.close();
  });
}

test('[SQLite] 用量账本：老库（没有 billing 列）打开时自动补列，套餐标记能存能读', async () => {
  const { default: Database } = await import('better-sqlite3');
  const file = join(mkdtempSync(join(tmpdir(), 'melon-old-')), 'old.db');
  // 先按新代码建库，再把列删掉，模拟第 1 期的老库
  openSqliteStores({ file, dims: 3 }).context.close();
  const raw = new Database(file);
  raw.exec('ALTER TABLE usage DROP COLUMN billing');
  raw.close();
  const b = openSqliteStores({ file, dims: 3 });
  await b.usage.record({
    at: 1, calls: 1, purpose: 'plan', egress: 'aliyun-coding', model: 'qwen3.7-plus', ok: true,
    inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: 0, currency: 'CNY', priced: true, ms: 1, billing: 'plan',
  });
  assert.equal((await b.usage.list({ from: 0, to: 10 }))[0]!.billing, 'plan');
  b.context.close();
});
