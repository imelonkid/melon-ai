import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventLog, Grant, GrantStore, Task, TaskEvent, TaskStore,
} from '@melon-ai/core';
import { ConflictError, asAgentId, asTaskId, asToolId } from '@melon-ai/core';
import { InMemoryEventLog, InMemoryGrantStore, InMemoryTaskStore } from '@melon-ai/testkit';
import { openSqliteStores } from '../src/index.js';

/**
 * ── 一致性测试 ──
 *
 * 同一组断言跑两遍：内存版与 SQLite 版。
 *
 * 理由很实际：测试全部用内存适配器写，如果两者的**并发语义**不一致
 * （乐观并发、单写者 `expectedSeq`），测试会全绿而线上出错。
 * 这类 bug 极难定位，所以把语义本身变成被测对象。
 */
interface Impl {
  readonly name: string;
  readonly tasks: TaskStore;
  readonly events: EventLog;
  readonly grants: GrantStore;
  readonly dispose: () => Promise<void>;
}

function memImpl(): Impl {
  return {
    name: '内存',
    tasks: new InMemoryTaskStore(),
    events: new InMemoryEventLog(() => 0),
    grants: new InMemoryGrantStore(),
    dispose: async () => {},
  };
}

function sqliteImpl(): Impl {
  const dir = mkdtempSync(join(tmpdir(), 'melon-conf-'));
  const b = openSqliteStores({ file: join(dir, 'test.db'), now: () => 0 });
  return { name: 'SQLite', tasks: b.tasks, events: b.events, grants: b.grants, dispose: b.close };
}

const IMPLS = [memImpl, sqliteImpl];

const ID = asTaskId('t1');
const AGENT = asAgentId('a1');
const MAIL = asToolId('mail.send');

const stub = (version: number, over: Partial<Task> = {}): Task => ({
  id: ID, rootId: ID, agentId: AGENT, kind: 'conversation', goal: 'g',
  state: 'PENDING', trigger: { type: 'manual' },
  budget: { maxSteps: 24, maxTokens: 1000, maxCostUSD: 1, maxWallClockMs: 1000 },
  usage: { steps: 0, tokens: 0, costUSD: 0, startedAt: 0 },
  toolset: { takenAt: 0, skills: [] }, episodeId: 'e1' as never,
  trace: { traceId: 'tr' as never, spanId: 'sp' as never },
  tainted: false, guard: { recentCalls: [], stagnantSteps: 0 },
  createdAt: 0, updatedAt: 0, version,
  ...over,
});

for (const make of IMPLS) {
  const { name } = make();

  test(`[${name}] TaskStore 乐观并发：旧版本号写入必须抛 ConflictError`, async () => {
    const impl = make();
    try {
      await impl.tasks.create(stub(0));
      await impl.tasks.save(stub(1), 0);
      await assert.rejects(() => impl.tasks.save(stub(2), 0), ConflictError,
        '拿旧版本号写入必须失败，否则并发下会丢更新');
      await impl.tasks.save(stub(2), 1);
      assert.equal((await impl.tasks.get(ID))?.version, 2);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] TaskStore 往返：Task 的所有字段都要能原样取回`, async () => {
    const impl = make();
    try {
      const t = stub(0, {
        state: 'AWAITING_APPROVAL',
        tainted: true,
        guard: { recentCalls: ['mail.send#h1', 'mail.send#h1'], stagnantSteps: 2 },
        pendingCall: { callId: 'c1' as never, toolId: MAIL, args: { to: 'x' }, argsHash: 'h1' },
        deadline: 12345,
        parentId: asTaskId('parent'),
        usage: { steps: 3, tokens: 500, costUSD: 0.02, startedAt: 7 },
      });
      await impl.tasks.create(t);
      const got = await impl.tasks.get(ID);
      assert.deepEqual(got, t, '字段丢失会让状态机在恢复后行为不同');
    } finally { await impl.dispose(); }
  });

  test(`[${name}] EventLog 单写者：expectedSeq 不符必须抛`, async () => {
    const impl = make();
    try {
      const e: TaskEvent = { t: 'Started' };
      assert.equal(await impl.events.append(ID, [e], 0), 1);
      await assert.rejects(() => impl.events.append(ID, [e], 0), ConflictError);
      assert.equal(await impl.events.append(ID, [e, e], 1), 3);
      assert.equal(await impl.events.lastSeq(ID), 3);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] EventLog 批量追加是原子的：seq 连续无空洞`, async () => {
    const impl = make();
    try {
      await impl.events.append(ID, [
        { t: 'ToolCallStarted', call: { callId: 'c' as never, toolId: MAIL, args: {}, argsHash: 'h' } },
        { t: 'ToolCallFinished', callId: 'c' as never, meta: { ok: true, metrics: { ms: 1, bytes: 0, retries: 0 } } },
        { t: 'Observed', callId: 'c' as never, summary: 'ok' },
      ], 0);
      const seqs: number[] = [];
      for await (const r of impl.events.read(ID)) seqs.push(r.seq);
      assert.deepEqual(seqs, [1, 2, 3], '事务边界规则要求这三条同批落盘');
    } finally { await impl.dispose(); }
  });

  test(`[${name}] EventLog.read 从 seq 续读`, async () => {
    const impl = make();
    try {
      await impl.events.append(ID, [{ t: 'Started' }, { t: 'Resumed' }, { t: 'Cancelled' }], 0);
      const got: string[] = [];
      for await (const r of impl.events.read(ID, 1)) got.push(r.value.t);
      assert.deepEqual(got, ['Resumed', 'Cancelled']);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] EventLog 事件载荷原样往返`, async () => {
    const impl = make();
    try {
      const ev: TaskEvent = {
        t: 'AdmissionResolved', callId: 'c1' as never, decision: 'ask',
        reason: '需要确认', risk: 'external', basis: { gate: 'matrix', mode: 'ask' },
      };
      await impl.events.append(ID, [ev], 0);
      const rows: TaskEvent[] = [];
      for await (const r of impl.events.read(ID)) rows.push(r.value);
      assert.deepEqual(rows[0], ev);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] EventLog 订阅只收追加后的事件，且可取消`, async () => {
    const impl = make();
    try {
      const seen: number[] = [];
      const off = impl.events.subscribe(ID, (e) => seen.push(e.seq));
      await impl.events.append(ID, [{ t: 'Started' }], 0);
      off();
      await impl.events.append(ID, [{ t: 'Resumed' }], 1);
      assert.deepEqual(seen, [1]);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] GrantStore 按 (agent, tool, scope) 精确匹配`, async () => {
    const impl = make();
    try {
      const g: Grant = { agentId: AGENT, toolId: MAIL, scope: 'to=产品组', grantedAt: 100 };
      await impl.grants.put(g);
      assert.deepEqual(await impl.grants.find(AGENT, MAIL, 'to=产品组'), g);
      assert.equal(await impl.grants.find(AGENT, MAIL, 'to=全体员工'), null,
        '换了 scope 不该命中 —— 否则「允许发给产品组」会变成「允许发给任何人」');
      assert.equal(await impl.grants.find(asAgentId('other'), MAIL, 'to=产品组'), null);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] GrantStore put 是 upsert，不产生重复`, async () => {
    const impl = make();
    try {
      await impl.grants.put({ agentId: AGENT, toolId: MAIL, scope: 's', grantedAt: 1 });
      await impl.grants.put({ agentId: AGENT, toolId: MAIL, scope: 's', grantedAt: 2 });
      const all = await impl.grants.listByAgent(AGENT);
      assert.equal(all.length, 1);
      assert.equal(all[0]?.grantedAt, 2);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] GrantStore revoke 不传 scope 则撤销该工具全部授权`, async () => {
    const impl = make();
    try {
      await impl.grants.put({ agentId: AGENT, toolId: MAIL, scope: 'a', grantedAt: 1 });
      await impl.grants.put({ agentId: AGENT, toolId: MAIL, scope: 'b', grantedAt: 1 });
      await impl.grants.revoke(AGENT, MAIL);
      assert.equal((await impl.grants.listByAgent(AGENT)).length, 0);
    } finally { await impl.dispose(); }
  });

  test(`[${name}] listByState / listDue 语义一致`, async () => {
    const impl = make();
    try {
      await impl.tasks.create(stub(0, { state: 'PLANNING' }));
      const t2 = stub(0, { state: 'SUSPENDED', deadline: 500 });
      await impl.tasks.create({ ...t2, id: asTaskId('t2') });
      const t3 = stub(0, { state: 'SUSPENDED' });
      await impl.tasks.create({ ...t3, id: asTaskId('t3') });

      assert.equal((await impl.tasks.listByState(['PLANNING'], 10)).length, 1);
      assert.equal((await impl.tasks.listByState(['SUSPENDED'], 10)).length, 2);
      const due = await impl.tasks.listDue(1000, 10);
      assert.equal(due.length, 1, '没有 deadline 的挂起任务不该被当成到期');
      assert.equal(due[0]?.id, 't2');
      assert.equal((await impl.tasks.listDue(100, 10)).length, 0);
    } finally { await impl.dispose(); }
  });
}
