import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRule, whenToRule } from '../../src/index.js';

const NOW = Date.parse('2026-09-29T08:00:00+08:00');
const opts = { tz: 'Asia/Shanghai', now: NOW };

test('once：本地日期字符串按目标时区解析；过去的时刻拒绝', () => {
  const r = whenToRule({ repeat: 'once', at: '2026-10-02 09:00' }, opts);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.rule.kind === 'once' && r.rule.at, Date.parse('2026-10-02T09:00:00+08:00'));
  assert.deepEqual(whenToRule({ repeat: 'once', at: '2026-09-28 09:00' }, opts), { ok: false, error: '这个时间已经过了' });
  assert.equal(whenToRule({ repeat: 'once', at: '明天' }, opts).ok, false);
});

test('工作日 = 每周一到周五；每周去重排序、非法星期丢掉，一天都没有则拒绝', () => {
  const w = whenToRule({ repeat: 'workdays', time: '9:05' }, opts);
  assert.deepEqual(w, { ok: true, rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: { hour: 9, minute: 5 }, tz: 'Asia/Shanghai' } });
  const k = whenToRule({ repeat: 'weekly', days: [5, 1, 5, 9], time: '16:00' }, opts);
  assert.ok(k.ok && k.rule.kind === 'weekly' && k.rule.days.join() === '1,5');
  assert.deepEqual(whenToRule({ repeat: 'weekly', days: [], time: '16:00' }, opts), { ok: false, error: '至少选一天' });
  assert.deepEqual(whenToRule({ repeat: 'daily', time: '25:00' }, opts), { ok: false, error: '时间要写成 HH:MM' });
});

test('描述：工作日、每周几（周日排最后）、间隔、一次性按时区', () => {
  assert.equal(describeRule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: { hour: 9, minute: 0 }, tz: 'UTC' }), '每个工作日 09:00');
  assert.equal(describeRule({ kind: 'weekly', days: [0, 5], time: { hour: 16, minute: 0 }, tz: 'UTC' }), '每周五、周日 16:00');
  assert.equal(describeRule({ kind: 'interval', everyMs: 2 * 3600_000 }), '每 2 小时');
  assert.equal(describeRule({ kind: 'once', at: Date.parse('2026-10-02T09:00:00+08:00') }, 'Asia/Shanghai'), '仅一次 · 10月2日 09:00');
  assert.equal(describeRule({ kind: 'once', at: Date.parse('2026-10-02T09:00:00+08:00') }, 'Asia/Shanghai', { bare: true }), '10月2日 09:00');
});
