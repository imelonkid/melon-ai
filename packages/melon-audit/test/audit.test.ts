import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditDraft, ResourceRef } from '@melon-ai/core';
import { MAX_DIMENSION_LENGTH, asTaskId, asTraceId } from '@melon-ai/core';
import {
  FakeClock, InMemoryAuditSink, InMemoryResolver, NodeHasher,
} from '@melon-ai/testkit';
import {
  ChainedRecorder, DEFAULT_RETENTION, DimensionTooLongError, InvalidRetentionError,
  assertRedacted, assertRetention, verifyChain,
} from '../src/index.js';

const hasher = new NodeHasher();
const REF: ResourceRef = { kind: 'mail', ref: 'mail-1', contentHash: 'abc' };

const draft = (over: Partial<AuditDraft> = {}): AuditDraft => ({
  at: 0,
  actor: { kind: 'agent', id: 'weekly' },
  action: 'tool.invoke',
  resource: REF,
  outcome: 'ok',
  traceId: asTraceId('tr-1'),
  taskId: asTaskId('t-1'),
  ...over,
});

const setup = async () => {
  const sink = new InMemoryAuditSink();
  const rec = new ChainedRecorder({ sink, hasher, clock: new FakeClock(5000) });
  await rec.resume();
  return { sink, rec };
};

// ───────────────────────── 哈希链 ─────────────────────────

test('链式写入：seq 递增、prevHash 串联', async () => {
  const { sink, rec } = await setup();
  await rec.record(draft());
  await rec.record(draft({ action: 'approval.decide' }));
  assert.equal(sink.rows.length, 2);
  assert.equal(sink.rows[0]!.seq, 1);
  assert.equal(sink.rows[0]!.prevHash, undefined, '第一条没有前驱');
  assert.equal(sink.rows[1]!.prevHash, sink.rows[0]!.hash);
  assert.equal(await rec.verify(), null);
});

test('篡改记录内容 → 链校验发现 hash-mismatch', async () => {
  const { sink, rec } = await setup();
  await rec.record(draft());
  await rec.record(draft({ outcome: 'ok' }));
  // 把第 1 条的结论从 ok 改成 deny，但不更新哈希
  sink.tamper(1, (r) => ({ ...r, outcome: 'deny' }));
  const broken = await rec.verify();
  assert.deepEqual(broken, { seq: 1, why: 'hash-mismatch' });
});

test('删掉中间一条 → 发现 seq-gap', async () => {
  const { sink, rec } = await setup();
  for (let i = 0; i < 3; i++) await rec.record(draft());
  sink.rows.splice(1, 1);
  const broken = await rec.verify();
  assert.deepEqual(broken, { seq: 3, why: 'seq-gap' });
});

test('重接前驱 → 发现 prev-mismatch（早于 hash 检查）', async () => {
  const { sink, rec } = await setup();
  await rec.record(draft());
  await rec.record(draft());
  // 只改第 2 条的 prevHash，把它从链上摘下来重接
  sink.tamper(2, (r) => ({ ...r, prevHash: 'DETACHED' }));
  const broken = verifyChain(hasher, [...sink.rows].sort((a, b) => a.seq - b.seq));
  assert.deepEqual(broken, { seq: 2, why: 'prev-mismatch' },
    '前驱检查必须早于哈希检查，否则「被摘下来重接」会误报成内容篡改');
});

test('contentHash 进链 —— 负载被换掉也能发现', async () => {
  const { sink, rec } = await setup();
  await rec.record(draft({ resource: { kind: 'mail', ref: 'm1', contentHash: 'AAA' } }));
  const before = sink.rows[0]!.hash;
  sink.tamper(1, (r) => ({ ...r, resource: { ...r.resource, contentHash: 'BBB' } }));
  assert.notEqual(sink.rows[0]!.hash, undefined);
  assert.equal(sink.rows[0]!.hash, before, '哈希字段本身没动');
  const broken = await rec.verify();
  assert.equal(broken?.why, 'hash-mismatch', '但重算后对不上，说明引用的负载被换过');
});

test('未 resume 直接写 → 抛错，避免把链写断', async () => {
  const rec = new ChainedRecorder({
    sink: new InMemoryAuditSink(), hasher, clock: new FakeClock(),
  });
  await assert.rejects(() => rec.record(draft()), /未 resume/);
});

test('resume 后接着写，seq 与 prevHash 从链尾续上', async () => {
  const sink = new InMemoryAuditSink();
  const a = new ChainedRecorder({ sink, hasher, clock: new FakeClock() });
  await a.resume();
  await a.record(draft());
  await a.record(draft());

  // 模拟进程重启
  const b = new ChainedRecorder({ sink, hasher, clock: new FakeClock() });
  await b.resume();
  await b.record(draft());

  assert.deepEqual(sink.rows.map((r) => r.seq), [1, 2, 3]);
  assert.equal(await b.verify(), null, '跨重启的链必须仍然完整');
});

// ───────────────────────── 脱敏 ─────────────────────────

test('维度值过长 → 抛错，而不是静默截断', () => {
  const long = 'x'.repeat(MAX_DIMENSION_LENGTH + 1);
  assert.throws(
    () => assertRedacted(draft({ dimensions: { body: long } })),
    DimensionTooLongError,
  );
});

test('正常维度（计数、类型、枚举）通过', () => {
  assert.doesNotThrow(() => assertRedacted(draft({
    dimensions: { recipientCount: 6, tool: 'mail.send', autoSent: false },
  })));
});

test('recorder 在写入前执行脱敏检查', async () => {
  const { sink, rec } = await setup();
  await assert.rejects(
    () => rec.record(draft({ dimensions: { body: 'y'.repeat(200) } })),
    DimensionTooLongError,
  );
  assert.equal(sink.rows.length, 0, '检查失败不应留下半条记录');
});

// ───────────────────────── 保留期 ─────────────────────────

test('负载保留期短于审计保留期 → 启动时拒绝', () => {
  assert.throws(
    () => assertRetention({ auditDays: 365, payloadDays: 90, keepForever: [] }),
    InvalidRetentionError,
  );
});

test('默认保留策略是合法的', () => {
  assert.doesNotThrow(() => assertRetention(DEFAULT_RETENTION));
});

test('prune 不清理 keepForever 里的动作', async () => {
  const { sink, rec } = await setup();
  await rec.record(draft({ at: 100, action: 'tool.invoke' }));
  await rec.record(draft({ at: 100, action: 'memory.recall' }));
  const removed = await sink.prune(200, ['tool.invoke']);
  assert.equal(removed, 1);
  assert.deepEqual(sink.rows.map((r) => r.action), ['tool.invoke']);
});

// ───────────────── 跨任务查询：EventLog 做不到的事 ─────────────────

test('按主体+动作聚合 —— 这是分 taskId 的事件日志答不了的问题', async () => {
  const { rec } = await setup();
  for (let i = 0; i < 3; i++) {
    await rec.record(draft({ taskId: asTaskId(`t-${i}`), action: 'tool.invoke' }));
  }
  await rec.record(draft({ taskId: asTaskId('t-9'), action: 'memory.recall' }));

  const sends = await rec.query({ actions: ['tool.invoke'], limit: 100 });
  assert.equal(sends.length, 3, '「这个 Agent 一共对外发了几次」要能一次查出来');
  assert.equal(new Set(sends.map((r) => r.taskId)).size, 3, '跨了三个任务');
});

test('按 traceId 串起一次触发的全部记录', async () => {
  const { rec } = await setup();
  await rec.record(draft({ traceId: asTraceId('A'), action: 'tool.invoke' }));
  await rec.record(draft({ traceId: asTraceId('A'), action: 'memory.write' }));
  await rec.record(draft({ traceId: asTraceId('B'), action: 'tool.invoke' }));
  const a = await rec.query({ traceId: asTraceId('A'), limit: 100 });
  assert.equal(a.length, 2);
});

test('准入依据被完整记下 —— 事后要能证明这次自动执行合规', async () => {
  const { rec } = await setup();
  await rec.record(draft({
    action: 'approval.decide',
    outcome: 'allow',
    basis: { gate: 'grant', scope: 'to=产品组', mode: 'low-risk-auto', grantedAt: 42 },
  }));
  const [r] = await rec.query({ actions: ['approval.decide'], limit: 1 });
  assert.equal(r?.basis?.gate, 'grant');
  assert.equal(r?.basis?.scope, 'to=产品组');
});

// ───────────────── 悬垂引用：删除后审计仍然有意义 ─────────────────

test('负载被隐私删除后，审计记录仍能证明「这件事发生过」', async () => {
  const { rec } = await setup();
  await rec.record(draft({
    action: 'tool.invoke',
    dimensions: { tool: 'mail.send', recipientCount: 6 },
  }));
  const resolver = new InMemoryResolver().kill(REF, 'privacy-optout', 999);

  const [r] = await rec.query({ limit: 1 });
  const resolved = await resolver.resolve([r!.resource]);
  const got = resolved.get(REF.ref);

  assert.equal(got?.status, 'deleted');
  assert.equal(got?.status === 'deleted' ? got.tombstone.reason : '', 'privacy-optout');
  // 负载没了，但维度还在 —— 仍知道「发生过一次发送，收件 6 人」，只是不知道发给谁
  assert.equal(r!.dimensions?.recipientCount, 6);
  assert.equal(r!.dimensions?.tool, 'mail.send');
});

test('解引用会报告负载是否被改动过', async () => {
  const resolver = new InMemoryResolver().put({ ...REF, contentHash: 'abc' }, { body: 'v1' });
  const ok = (await resolver.resolve([REF])).get(REF.ref);
  assert.equal(ok?.status === 'ok' && ok.contentHashMatches, true);

  const tampered = new InMemoryResolver().put({ ...REF, contentHash: 'CHANGED' }, { body: 'v2' });
  const bad = await tampered.resolve([REF]);
  const g = bad.get(REF.ref);
  assert.equal(g?.status === 'ok' && g.contentHashMatches, false,
    'contentHash 对不上必须被报告出来，这是坑一的防线');
});

test('从未存在与已删除要能区分开', async () => {
  const resolver = new InMemoryResolver();
  const r = await resolver.resolve([{ kind: 'mail', ref: 'never' }]);
  assert.equal(r.get('never')?.status, 'missing');
});
