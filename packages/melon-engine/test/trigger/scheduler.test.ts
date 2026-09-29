import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentId, Logger, Schedule, ScheduleId, ScheduleStatus, ScheduleStore, TaskId, TaskSpec,
} from '@melon-ai/core';
import { Scheduler } from '../../src/trigger/orchestrator.js';

/** 内存假存储。够用就行 —— 真实现的行为由 store-sqlite 自己的测试盯。 */
class FakeStore implements ScheduleStore {
  readonly rows = new Map<string, Schedule>();
  async put(s: Schedule) { this.rows.set(s.id, s); }
  async get(id: ScheduleId) { return this.rows.get(id) ?? null; }
  async listDue(now: number) {
    return [...this.rows.values()]
      .filter(s => s.status === 'active' && s.nextFireAt !== null && s.nextFireAt <= now);
  }
  async list(agentId?: AgentId, status?: ScheduleStatus) {
    return [...this.rows.values()].filter(s =>
      (status ? s.status === status : s.status !== 'removed') &&
      (agentId ? s.template.agentId === agentId : true));
  }
  async supersede(oldId: ScheduleId, newId: ScheduleId) {
    const prev = this.rows.get(oldId);
    if (prev) this.rows.set(oldId, { ...prev, supersededBy: newId, status: 'removed' });
  }
}

const silent: Logger = { log() {}, child() { return silent; } };

function harness(startAt = Date.parse('2026-09-29T08:00:00+08:00')) {
  const store = new FakeStore();
  const submitted: TaskSpec[] = [];
  let now = startAt;
  let n = 0;
  const scheduler = new Scheduler({
    store,
    submit: async (spec) => { submitted.push(spec); return { id: `task-${++n}` as TaskId }; },
    clock: { now: () => now },
    ids: { next: (p = 'id') => `${p}-${++n}` },
    logger: silent,
  });
  return { store, submitted, scheduler, advance: (ms: number) => { now += ms; }, at: () => now };
}

const template = {
  agentId: 'weekly-report' as AgentId,
  kind: 'automation' as const,
  goal: '汇总本周进展并发邮件给产品组',
};

test('新建后 nextFireAt 落在将来', async () => {
  const h = harness();
  const s = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  assert.equal(s.status, 'active');
  assert.ok(s.nextFireAt! > h.at());
  assert.equal(s.fireCount, 0);
});

test('到点触发，trigger.ref 指回 schedule', async () => {
  const h = harness();
  const s = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  assert.equal(await h.scheduler.tick(), 0); // 还没到点

  h.advance(2 * 3600_000); // 到 10:00
  assert.equal(await h.scheduler.tick(), 1);
  assert.equal(h.submitted.length, 1);
  assert.deepEqual(h.submitted[0]!.trigger, { type: 'schedule', ref: s.id });
  assert.equal(h.submitted[0]!.goal, template.goal);

  const after = (await h.scheduler.get(s.id))!;
  assert.equal(after.fireCount, 1);
  assert.ok(after.nextFireAt! > h.at());
});

test('同一次到期不会被触发两次', async () => {
  const h = harness();
  await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  h.advance(2 * 3600_000);
  await h.scheduler.tick();
  await h.scheduler.tick();
  await h.scheduler.tick();
  assert.equal(h.submitted.length, 1);
});

test('catchUp=skip：停机三天回来只跑一次', async () => {
  const h = harness();
  await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  h.advance(3 * 86_400_000 + 2 * 3600_000);
  assert.equal(await h.scheduler.tick(), 1);
  assert.equal(h.submitted.length, 1);
});

test('catchUp=all：停机三天回来把欠的都补上', async () => {
  const h = harness();
  await h.scheduler.create({
    title: '周报', template, catchUp: 'all',
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  h.advance(3 * 86_400_000 + 2 * 3600_000);
  assert.equal(await h.scheduler.tick(), 3);
  assert.equal(h.submitted.length, 3);
});

test('提交失败不会卡在到期状态反复重试', async () => {
  const store = new FakeStore();
  let now = Date.parse('2026-09-29T08:00:00+08:00');
  let n = 0;
  let calls = 0;
  const scheduler = new Scheduler({
    store,
    submit: async () => { calls += 1; throw new Error('内核未启动'); },
    clock: { now: () => now },
    ids: { next: (p = 'id') => `${p}-${++n}` },
    logger: silent,
  });
  const s = await scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  now += 2 * 3600_000;
  assert.equal(await scheduler.tick(), 0);
  assert.equal(await scheduler.tick(), 0);
  // 只试了一次：nextFireAt 在 submit 之前就推进了
  assert.equal(calls, 1);
  const after = (await scheduler.get(s.id))!;
  assert.equal(after.fireCount, 0);
  assert.ok(after.nextFireAt! > now);
});

test('暂停后不再触发，恢复后重新排期', async () => {
  const h = harness();
  const s = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  await h.scheduler.setStatus(s.id, 'paused');
  h.advance(2 * 3600_000);
  assert.equal(await h.scheduler.tick(), 0);

  await h.scheduler.resume(s.id);
  h.advance(86_400_000);
  assert.equal(await h.scheduler.tick(), 1);
});

test('删除不物理删 —— 历史任务的 trigger.ref 还指着它', async () => {
  const h = harness();
  const s = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  await h.scheduler.setStatus(s.id, 'removed');
  assert.notEqual(await h.scheduler.get(s.id), null);
  assert.equal((await h.scheduler.get(s.id))!.status, 'removed');
  // 但列表默认看不见
  assert.equal((await h.scheduler.list()).length, 0);
});

test('删除后不能恢复', async () => {
  const h = harness();
  const s = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  await h.scheduler.setStatus(s.id, 'removed');
  await assert.rejects(() => h.scheduler.resume(s.id), /已删除/);
});

test('改规则走版本链：新建一条，旧的指向它', async () => {
  const h = harness();
  const a = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  const b = await h.scheduler.update(a.id, {
    rule: { kind: 'daily', time: { hour: 17, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  assert.notEqual(b.id, a.id);
  const old = (await h.scheduler.get(a.id))!;
  assert.equal(old.supersededBy, b.id);
  // 旧的不再触发
  h.advance(2 * 3600_000);
  assert.equal(await h.scheduler.tick(), 0);
});

test('只改标题不推后下一次触发', async () => {
  const h = harness();
  const a = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  const b = await h.scheduler.update(a.id, { title: '产品组周报' });
  assert.equal(b.nextFireAt, a.nextFireAt);
});

test('已被取代的那条不能再改', async () => {
  const h = harness();
  const a = await h.scheduler.create({
    title: '周报', template,
    rule: { kind: 'daily', time: { hour: 9, minute: 0 }, tz: 'Asia/Shanghai' },
  });
  await h.scheduler.update(a.id, { title: '改一次' });
  await assert.rejects(() => h.scheduler.update(a.id, { title: '再改' }), /已被/);
});

test('一次性任务跑完就不再排期', async () => {
  const h = harness();
  const s = await h.scheduler.create({
    title: '一次性', template,
    rule: { kind: 'once', at: h.at() + 3600_000 },
  });
  h.advance(2 * 3600_000);
  assert.equal(await h.scheduler.tick(), 1);
  assert.equal((await h.scheduler.get(s.id))!.nextFireAt, null);
  h.advance(86_400_000);
  assert.equal(await h.scheduler.tick(), 0);
});

test('start() 之后新建，轮询不会停：到点照样自己触发', async () => {
  // 回归：rearm() 曾把轮询循环的定时器换成只跑一次的 tick，
  // 新建之后调度器就再也不转了。这里用真定时器 + start()，不手动调 tick()
  const h = harness();
  h.scheduler.start(10);
  try {
    await h.scheduler.create({ title: '一次性', template, rule: { kind: 'once', at: h.at() + 60_000 } });
    await new Promise((r) => setTimeout(r, 30)); // rearm 的那一轮已经跑完
    h.advance(61_000);
    await new Promise((r) => setTimeout(r, 50)); // 靠循环自己再转几轮
    assert.equal(h.submitted.length, 1);
  } finally {
    h.scheduler.stop();
  }
});

test('连续 rearm 不会叠出多个轮询循环', async () => {
  const h = harness();
  h.scheduler.start(10);
  try {
    for (let i = 0; i < 5; i++) {
      await h.scheduler.create({ title: `t${i}`, template, rule: { kind: 'once', at: h.at() + 60_000 } });
    }
    let ticks = 0;
    const orig = h.scheduler.tick.bind(h.scheduler);
    h.scheduler.tick = async () => { ticks++; return orig(); };
    await new Promise((r) => setTimeout(r, 105));
    // 单循环 10ms 一轮，100ms 内约 10 轮；叠出 5 个循环会是 50 轮上下
    assert.ok(ticks <= 15, `100ms 内 tick 了 ${ticks} 次，轮询循环叠加了`);
  } finally {
    h.scheduler.stop();
  }
});
