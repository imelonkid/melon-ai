import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Recurrence } from '@melon-ai/core';
import { advancePast, nextFireAt } from '../src/recurrence.js';

/** 断言用：把时间戳按目标时区渲染成 "YYYY-MM-DD HH:mm"，肉眼可读。 */
function show(ts: number, tz: string): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const g: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) g[p.type] = p.value;
  return `${g.year}-${g.month}-${g.day} ${String(Number(g.hour) % 24).padStart(2, '0')}:${g.minute}`;
}

const SH = 'Asia/Shanghai';
const NY = 'America/New_York';

test('daily：当天时刻还没到就取当天', () => {
  const rule: Recurrence = { kind: 'daily', time: { hour: 9, minute: 0 }, tz: SH };
  const at = Date.parse('2026-09-29T00:30:00+08:00');
  assert.equal(show(nextFireAt(rule, at)!, SH), '2026-09-29 09:00');
});

test('daily：当天时刻已过就取第二天', () => {
  const rule: Recurrence = { kind: 'daily', time: { hour: 9, minute: 0 }, tz: SH };
  const at = Date.parse('2026-09-29T09:00:01+08:00');
  assert.equal(show(nextFireAt(rule, at)!, SH), '2026-09-30 09:00');
});

test('daily：正好等于触发时刻要前进，否则同一时刻会被反复触发', () => {
  const rule: Recurrence = { kind: 'daily', time: { hour: 9, minute: 0 }, tz: SH };
  const exact = Date.parse('2026-09-29T09:00:00+08:00');
  assert.equal(show(nextFireAt(rule, exact)!, SH), '2026-09-30 09:00');
});

test('daily：跨 DST 秋季回拨，本地时刻不变（不是差一小时）', () => {
  // 美东 2026-11-01 凌晨 2:00 回拨到 1:00
  const rule: Recurrence = { kind: 'daily', time: { hour: 9, minute: 0 }, tz: NY };
  const before = Date.parse('2026-10-31T12:00:00Z');
  const first = nextFireAt(rule, before)!;
  assert.equal(show(first, NY), '2026-10-31 09:00');
  const second = nextFireAt(rule, first)!;
  assert.equal(show(second, NY), '2026-11-01 09:00');
  // 真正的验证点：跨回拨这天相隔 25 小时，不是 24
  assert.equal(second - first, 25 * 3600_000);
});

test('daily：跨 DST 春季前跳，相隔 23 小时', () => {
  // 美东 2026-03-08 凌晨 2:00 跳到 3:00
  const rule: Recurrence = { kind: 'daily', time: { hour: 9, minute: 0 }, tz: NY };
  const first = nextFireAt(rule, Date.parse('2026-03-07T00:00:00Z'))!;
  assert.equal(show(first, NY), '2026-03-07 09:00');
  const second = nextFireAt(rule, first)!;
  assert.equal(show(second, NY), '2026-03-08 09:00');
  assert.equal(second - first, 23 * 3600_000);
});

test('daily：落在春季前跳的空洞里（2:30 那天不存在）取跳变之后', () => {
  const rule: Recurrence = { kind: 'daily', time: { hour: 2, minute: 30 }, tz: NY };
  const ts = nextFireAt(rule, Date.parse('2026-03-08T00:00:00-05:00'))!;
  // 宁可晚跑半小时，也不漏跑一天
  const rendered = show(ts, NY);
  assert.equal(rendered.slice(0, 10), '2026-03-08', `落到了 ${rendered}`);
  assert.ok(rendered >= '2026-03-08 03:00', `期望跳变之后，实际 ${rendered}`);
});

test('weekly：只在指定的星期触发', () => {
  // 周一、周五
  const rule: Recurrence = { kind: 'weekly', days: [1, 5], time: { hour: 16, minute: 0 }, tz: SH };
  // 2026-09-29 是周二
  let cursor = Date.parse('2026-09-29T00:00:00+08:00');
  const got: string[] = [];
  for (let i = 0; i < 4; i++) {
    cursor = nextFireAt(rule, cursor)!;
    got.push(show(cursor, SH));
  }
  assert.deepEqual(got, [
    '2026-10-02 16:00', // 周五
    '2026-10-05 16:00', // 周一
    '2026-10-09 16:00', // 周五
    '2026-10-12 16:00', // 周一
  ]);
});

test('weekly：days 为空不会触发，而不是每天都触发', () => {
  const rule: Recurrence = { kind: 'weekly', days: [], time: { hour: 9, minute: 0 }, tz: SH };
  assert.equal(nextFireAt(rule, Date.now()), null);
});

test('once：跑过就不再触发', () => {
  const at = Date.parse('2026-09-29T09:00:00+08:00');
  const rule: Recurrence = { kind: 'once', at };
  assert.equal(nextFireAt(rule, at - 1), at);
  assert.equal(nextFireAt(rule, at), null);
});

test('interval：非正数间隔不触发，不会变成死循环', () => {
  assert.equal(nextFireAt({ kind: 'interval', everyMs: 0 }, 1000), null);
  assert.equal(nextFireAt({ kind: 'interval', everyMs: -5 }, 1000), null);
  assert.equal(nextFireAt({ kind: 'interval', everyMs: 60_000 }, 1000), 61_000);
});

test('advancePast：停机三天的每日任务欠三次，下一次落在将来', () => {
  const rule: Recurrence = { kind: 'daily', time: { hour: 9, minute: 0 }, tz: SH };
  const from = Date.parse('2026-09-26T09:00:00+08:00');
  const now = Date.parse('2026-09-29T10:00:00+08:00');
  const { missed, next } = advancePast(rule, from, now);
  assert.equal(missed, 3); // 27、28、29
  assert.equal(show(next!, SH), '2026-09-30 09:00');
});

test('advancePast：一次性任务过期后 next 为 null', () => {
  const at = Date.parse('2026-09-01T09:00:00+08:00');
  const { missed, next } = advancePast({ kind: 'once', at }, at - 1000, at + 1000);
  assert.equal(missed, 1);
  assert.equal(next, null);
});

test('advancePast：maxSteps 兜住高频规则，不空转到天荒地老', () => {
  const rule: Recurrence = { kind: 'interval', everyMs: 1000 };
  const now = Date.now();
  const { missed } = advancePast(rule, now - 86_400_000, now, 50);
  assert.equal(missed, 50);
});
