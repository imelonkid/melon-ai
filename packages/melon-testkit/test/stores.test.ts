import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskEvent } from '@melon-ai/core';
import { ConflictError, asTaskId } from '@melon-ai/core';
import { FakeClock, InMemoryEventLog, InMemoryTaskStore, RecordingTracer, SeqIdGen } from '../src/index.js';

const ID = asTaskId('t1');
const stub = (version: number): Task => ({
  id: ID, rootId: ID, agentId: 'a' as never, kind: 'conversation', goal: 'g',
  state: 'PENDING', trigger: { type: 'manual' },
  budget: { maxSteps: 1, maxTokens: 1, maxCostUSD: 1, maxWallClockMs: 1 },
  usage: { steps: 0, tokens: 0, costUSD: 0, startedAt: 0 },
  toolset: { takenAt: 0, skills: [] }, episodeId: 'e' as never,
  trace: { traceId: 'tr' as never, spanId: 'sp' as never },
  tainted: false, guard: { recentCalls: [], stagnantSteps: 0 },
  createdAt: 0, updatedAt: 0, version,
});

test('TaskStore 乐观并发：版本不符必须抛 ConflictError', async () => {
  const s = new InMemoryTaskStore();
  await s.create(stub(0));
  await s.save(stub(1), 0);
  await assert.rejects(() => s.save(stub(2), 0), ConflictError,
    '拿旧版本号写入必须失败，否则并发下会丢更新');
  await s.save(stub(2), 1);
});

test('EventLog 单写者：expectedSeq 不符必须抛，否则事件顺序不可信', async () => {
  const log = new InMemoryEventLog(() => 0);
  const e: TaskEvent = { t: 'Started' };
  assert.equal(await log.append(ID, [e], 0), 1);
  await assert.rejects(() => log.append(ID, [e], 0), ConflictError);
  assert.equal(await log.append(ID, [e, e], 1), 3);
  assert.deepEqual(log.all(ID).map((r) => r.seq), [1, 2, 3]);
});

test('EventLog.read 支持从 seq 续读 —— 重放与订阅衔接靠它', async () => {
  const log = new InMemoryEventLog(() => 0);
  await log.append(ID, [{ t: 'Started' }, { t: 'Resumed' }, { t: 'Cancelled' }], 0);
  const got: string[] = [];
  for await (const row of log.read(ID, 1)) got.push(row.value.t);
  assert.deepEqual(got, ['Resumed', 'Cancelled']);
});

test('EventLog 订阅只收到追加后的事件，且可取消', async () => {
  const log = new InMemoryEventLog(() => 0);
  const seen: number[] = [];
  const off = log.subscribe(ID, (e) => seen.push(e.seq));
  await log.append(ID, [{ t: 'Started' }], 0);
  off();
  await log.append(ID, [{ t: 'Resumed' }], 1);
  assert.deepEqual(seen, [1]);
});

test('FakeClock 是输入而不是环境', () => {
  const c = new FakeClock(1000);
  assert.equal(c.now(), 1000);
  assert.equal(c.advance(50).now(), 1050);
});

test('RecordingTracer：child 保持 traceId、链上 parentSpanId', () => {
  const tr = new RecordingTracer(new SeqIdGen());
  const root = tr.root();
  const kid = tr.child(root);
  assert.equal(kid.traceId, root.traceId, 'traceId 在一次触发内必须不变');
  assert.equal(kid.parentSpanId, root.spanId);
  assert.notEqual(kid.spanId, root.spanId);
});

test('RecordingTracer 能查出漏 end 的 span', () => {
  const tr = new RecordingTracer(new SeqIdGen());
  const root = tr.root();
  tr.startSpan('a', 'tool', root);
  assert.equal(tr.unclosed().length, 1);
  tr.startSpan('b', 'model', root).end({ ok: true });
  assert.equal(tr.unclosed().length, 1, '只剩 a 没闭合');
});

test('root(replayOf) 带上重放来源 —— 重放不能污染原 trace', () => {
  const tr = new RecordingTracer(new SeqIdGen());
  const orig = tr.root();
  const replay = tr.root(orig.traceId);
  assert.notEqual(replay.traceId, orig.traceId, '重放必须是新的 traceId');
  assert.equal(replay.replayOf, orig.traceId);
});
