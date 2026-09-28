import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  EpisodeId, Episode, EpisodeStore, Entry, EpisodeSummary, PlanStep, Task, TaskId,
  ToolDescriptor, ToolHandler, ToolsetSnapshot,
} from '@melon-ai/core';
import { asEpisodeId, asSkillId, asToolId } from '@melon-ai/core';
import { ChainedRecorder } from '@melon-ai/audit';
import { ToolPipeline } from '@melon-ai/tools';
import {
  CapturingLogger, FakeClock, InMemoryArtifactStore, InMemoryAuditSink, InMemoryEventLog,
  InMemoryGrantStore, InMemoryIdempotencyStore, InMemoryTaskStore, NodeHasher, RecordingTracer,
  ScriptedPlanner, SeqIdGen, StaticToolResolver, StructuralValidator, noTools, stubContext,
} from '@melon-ai/testkit';
import { Runtime } from '../src/index.js';

const MAIL = asToolId('mail.send');

/** 极简 EpisodeStore —— runtime 只用到 open/append/close。 */
class MiniEpisodes implements EpisodeStore {
  readonly rows = new Map<string, Episode & { entries: Entry[] }>();
  private n = 0;
  async open(rootId: TaskId, at: number): Promise<EpisodeId> {
    const id = asEpisodeId(`ep-${++this.n}`);
    this.rows.set(id, { id, rootId, state: 'open', openedAt: at, entries: [] });
    return id;
  }
  async append(id: EpisodeId, entry: Entry): Promise<void> { this.rows.get(id)!.entries.push(entry); }
  async close(id: EpisodeId, at: number): Promise<void> {
    const e = this.rows.get(id)!;
    this.rows.set(id, { ...e, state: 'closed', closedAt: at });
  }
  async setSummary(id: EpisodeId, summary: EpisodeSummary): Promise<void> {
    const e = this.rows.get(id)!;
    this.rows.set(id, { ...e, summary });
  }
  async get(id: EpisodeId): Promise<Episode | null> { return this.rows.get(id) ?? null; }
  async list(rootId: TaskId): Promise<readonly Episode[]> {
    return [...this.rows.values()].filter((e) => e.rootId === rootId);
  }
  async readEntries(id: EpisodeId): Promise<readonly Entry[]> { return this.rows.get(id)?.entries ?? []; }
}

const TOOLSET: ToolsetSnapshot = { takenAt: 0, skills: [{ id: asSkillId('mail'), version: '1' }] };

const mailDesc: ToolDescriptor = {
  id: MAIL, skillId: asSkillId('mail'), name: 'send', description: '发邮件',
  input: { required: ['to'], properties: { to: { type: 'string' } } },
  risk: 'external', idempotent: false, scopeKeys: ['to'],
};

interface World {
  runtime: Runtime;
  tasks: InMemoryTaskStore;
  events: InMemoryEventLog;
  audit: ChainedRecorder;
  sink: InMemoryAuditSink;
  episodes: MiniEpisodes;
  logger: CapturingLogger;
  planner: ScriptedPlanner;
  sent: () => number;
  clock: FakeClock;
}

async function world(opts: {
  script: readonly (PlanStep | ((i: never) => PlanStep))[];
  handler?: ToolHandler;
  mode?: 'ask' | 'low-risk-auto' | 'all-auto';
  shared?: Partial<Pick<World, 'tasks' | 'events' | 'episodes' | 'sink'>>;
}): Promise<World> {
  const clock = new FakeClock(1000);
  const hasher = new NodeHasher();
  const ids = new SeqIdGen();
  const tracer = new RecordingTracer(ids);
  const logger = new CapturingLogger();
  const tasks = opts.shared?.tasks ?? new InMemoryTaskStore();
  const events = opts.shared?.events ?? new InMemoryEventLog(() => clock.now());
  const episodes = opts.shared?.episodes ?? new MiniEpisodes();
  const sink = opts.shared?.sink ?? new InMemoryAuditSink();
  const audit = new ChainedRecorder({ sink, hasher, clock });
  await audit.resume();

  let sent = 0;
  const resolver = new StaticToolResolver().add({
    descriptor: mailDesc,
    handler: opts.handler ?? (async () => { sent++; return { summary: '已发送给 6 人' }; }),
  });
  const pipeline = new ToolPipeline({
    resolver, validator: new StructuralValidator(),
    grants: new InMemoryGrantStore(),
    artifacts: new InMemoryArtifactStore(() => clock.now()),
    audit, clock, hasher, tracer, logger,
    idempotency: new InMemoryIdempotencyStore(),
    sleep: async () => {},
    execute: { timeoutMs: 100, maxRetries: 0, backoffBaseMs: 0 },
  });
  const planner = new ScriptedPlanner(opts.script as never);

  const runtime = new Runtime({
    tasks, events, episodes, pipeline, planner, ids, tracer, logger,
    now: () => clock.now(),
    transaction: async (fn) => fn(),
    policyMode: () => opts.mode ?? 'all-auto',
    buildContext: async () => stubContext(),
    availableTools: async () => noTools,
    toolset: () => TOOLSET,
    pollIntervalMs: 0,
  });
  return { runtime, tasks, events, audit, sink, episodes, logger, planner, sent: () => sent, clock };
}

const mailCall = (n = 1) => ({
  callId: `c-${n}` as never, toolId: MAIL, args: { to: '产品组' }, argsHash: `h${n}`,
});

const spec = () => ({
  agentId: 'weekly' as never, kind: 'conversation' as const,
  goal: '发周报', trigger: { type: 'manual' as const },
});

// ─────────────────── 单步直答 ───────────────────

test('最简任务：规划一次即收敛', async () => {
  const w = await world({ script: [{ kind: 'final', thought: '直接答', answer: '好了' }] });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();

  const final = await w.tasks.get(t.id);
  assert.equal(final?.state, 'SUCCEEDED');
  assert.equal(final?.outcome?.answer, '好了');
  assert.deepEqual(w.events.types(t.id), ['Created', 'Started', 'PlanProduced', 'Settled']);
});

// ─────────────────── 工具调用全链路 ───────────────────

test('all-auto：工具调用一路走通，事件序列完整', async () => {
  const w = await world({
    script: [
      { kind: 'tool_call', thought: '先发', call: mailCall() },
      { kind: 'final', thought: '完成', answer: '周报已发送' },
    ],
  });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();

  assert.equal((await w.tasks.get(t.id))?.state, 'SUCCEEDED');
  assert.equal(w.sent(), 1);
  assert.deepEqual(w.events.types(t.id), [
    'Created', 'Started', 'PlanProduced', 'AdmissionResolved',
    'ToolCallStarted', 'ToolCallFinished', 'Observed', 'PlanProduced', 'Settled',
  ]);
});

test('ToolCallFinished 与 Observed 在同一事务提交 —— OBSERVING 不作为静止状态落盘', async () => {
  const w = await world({
    script: [
      { kind: 'tool_call', thought: '发', call: mailCall() },
      { kind: 'final', thought: '完成', answer: 'ok' },
    ],
  });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();
  // 三条事件 seq 连续，说明是一次 append
  const rows = w.events.all(t.id);
  const i = rows.findIndex((r) => r.value.t === 'ToolCallStarted');
  assert.deepEqual(
    [rows[i]!.value.t, rows[i + 1]!.value.t, rows[i + 2]!.value.t],
    ['ToolCallStarted', 'ToolCallFinished', 'Observed'],
  );
});

// ─────────────────── 审批挂起与恢复 ───────────────────

test('ask 策略：任务停在 AWAITING_APPROVAL，工具未执行', async () => {
  const w = await world({
    mode: 'ask',
    script: [{ kind: 'tool_call', thought: '发', call: mailCall() }],
  });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();

  const task = await w.tasks.get(t.id);
  assert.equal(task?.state, 'AWAITING_APPROVAL');
  assert.equal(w.sent(), 0, '等审批期间绝不能执行');
  assert.equal(task?.pendingCall?.callId, 'c-1');
  assert.ok(w.events.types(t.id).includes('ApprovalRequested'));
});

test('批准后继续执行到收敛', async () => {
  const w = await world({
    mode: 'ask',
    script: [
      { kind: 'tool_call', thought: '发', call: mailCall() },
      { kind: 'final', thought: '完成', answer: '已发送' },
    ],
  });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();
  await w.runtime.resolveApproval(t.id, 'c-1', 'allow');
  await w.runtime.drain();

  assert.equal((await w.tasks.get(t.id))?.state, 'SUCCEEDED');
  assert.equal(w.sent(), 1);
});

test('拒绝后不是失败，而是把拒绝当 observation 让模型改道', async () => {
  const w = await world({
    mode: 'ask',
    script: [
      { kind: 'tool_call', thought: '发', call: mailCall() },
      { kind: 'final', thought: '那就存草稿', answer: '草稿已保存，未发送' },
    ],
  });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();
  await w.runtime.resolveApproval(t.id, 'c-1', 'deny');
  await w.runtime.drain();

  const task = await w.tasks.get(t.id);
  assert.equal(task?.state, 'SUCCEEDED', '拒绝一次不该让任务死掉');
  assert.equal(task?.outcome?.answer, '草稿已保存，未发送');
  assert.equal(w.sent(), 0);
});

// ─────────────────── P0 验收：崩溃恢复 ───────────────────

test('P0 验收：审批挂起 → 进程重启 → 从事件日志恢复并跑完', async () => {
  const shared = {
    tasks: new InMemoryTaskStore(),
    events: new InMemoryEventLog(),
    episodes: new MiniEpisodes(),
    sink: new InMemoryAuditSink(),
  };

  // ① 第一个进程：跑到等审批
  const w1 = await world({
    mode: 'ask', shared,
    script: [{ kind: 'tool_call', thought: '发', call: mailCall() }],
  });
  const t = await w1.runtime.submit(spec());
  await w1.runtime.drain();
  await w1.runtime.stop();
  assert.equal((await shared.tasks.get(t.id))?.state, 'AWAITING_APPROVAL');
  const seqBefore = await shared.events.lastSeq(t.id);

  // ② 换一个全新的 Runtime，只共享存储 —— 模拟进程重启
  let sent2 = 0;
  const w2 = await world({
    mode: 'ask', shared,
    handler: async () => { sent2++; return { summary: '已发送给 6 人' }; },
    script: [{ kind: 'final', thought: '完成', answer: '周报已发送' }],
  });
  await w2.runtime.start();
  await w2.runtime.drain();

  // AWAITING_APPROVAL 是「等人」状态，恢复时不该做任何事
  assert.equal(await shared.events.lastSeq(t.id), seqBefore, '恢复不该凭空追加事件');
  assert.equal(sent2, 0);

  // ③ 用户在新进程里批准
  await w2.runtime.resolveApproval(t.id, 'c-1', 'allow');
  await w2.runtime.drain();

  const final = await shared.tasks.get(t.id);
  assert.equal(final?.state, 'SUCCEEDED');
  assert.equal(final?.outcome?.answer, '周报已发送');
  assert.equal(sent2, 1, '跨进程批准后才真正发送');
  assert.equal(await w2.audit.verify(), null, '审计链跨进程仍然完整');
});

test('恢复 PLANNING 状态的任务会重新规划（崩在模型调用中）', async () => {
  const shared = {
    tasks: new InMemoryTaskStore(),
    events: new InMemoryEventLog(),
    episodes: new MiniEpisodes(),
    sink: new InMemoryAuditSink(),
  };
  // ① 用 apply 直接造出「已 Started、CallPlanner 还没跑」的静止状态 ——
  //    这正是崩在模型调用中会留下的现场
  const w1 = await world({ shared, script: [] });
  const t = await w1.runtime.submit(spec());
  await Promise.allSettled([w1.runtime.drain()]);
  // 空脚本会让规划失败并收敛，所以手工把状态摆回 PLANNING
  const cur = (await shared.tasks.get(t.id))!;
  const { outcome: _dropped, ...withoutOutcome } = cur;
  await shared.tasks.save({ ...withoutOutcome, state: 'PLANNING' }, cur.version);

  // ② 新 Runtime 恢复
  const w2 = await world({
    shared, script: [{ kind: 'final', thought: '恢复后完成', answer: 'done' }],
  });
  const recovered = await w2.runtime.recover();
  await w2.runtime.drain();

  assert.ok(recovered >= 1, '应当发现至少一个待恢复任务');
  const final = await shared.tasks.get(t.id);
  assert.equal(final?.state, 'SUCCEEDED');
  assert.equal(final?.outcome?.answer, 'done');
  assert.equal(w2.planner.remaining, 0, '恢复后必须真的重新调了一次规划器');
});

// ─────────────────── 守卫在真实循环里生效 ───────────────────

test('循环检测：模型反复同参调用同一工具时被拦住', async () => {
  const same = () => ({ kind: 'tool_call' as const, thought: '再试一次', call: mailCall(1) });
  const w = await world({
    script: [same(), same(), same(), { kind: 'final', thought: '换路', answer: '卡住了，需要你帮忙' }],
  });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();

  const types = w.events.types(t.id);
  assert.ok(types.includes('LoopDetected'), '第三次相同调用应被拦下');
  assert.equal((await w.tasks.get(t.id))?.state, 'SUCCEEDED');
  assert.ok(w.sent() <= 2, '被拦住的那次不该真的执行');
});

test('预算耗尽：步数超限后任务失败', async () => {
  const w = await world({
    script: Array.from({ length: 10 }, () => ({
      kind: 'tool_call' as const, thought: 'x', call: mailCall(Math.random()),
    })),
  });
  const t = await w.runtime.submit({ ...spec(), budget: { maxSteps: 3 } });
  await w.runtime.drain();
  const task = await w.tasks.get(t.id);
  assert.equal(task?.state, 'FAILED');
  assert.match(task?.outcome?.reason ?? '', /预算耗尽/);
});

// ─────────────────── watch ───────────────────

test('watch 回放历史后转为实时，且不重不漏', async () => {
  const w = await world({
    script: [
      { kind: 'tool_call', thought: '发', call: mailCall() },
      { kind: 'final', thought: '完成', answer: 'ok' },
    ],
  });
  const t = await w.runtime.submit(spec());
  const seen: string[] = [];
  const done = (async () => {
    for await (const e of w.runtime.watch(t.id)) seen.push(e.value.t);
  })();
  await w.runtime.drain();
  await done;

  assert.deepEqual(seen, w.events.types(t.id));
  assert.equal(new Set(seen.map((_, i) => i)).size, seen.length);
});

// ─────────────────── 串行化 ───────────────────

test('同一任务的并发推进被串行化，不产生 seq 冲突', async () => {
  const w = await world({ script: [{ kind: 'final', thought: 'x', answer: 'ok' }] });
  const t = await w.runtime.submit(spec());
  await w.runtime.drain();
  // 终态后并发取消，应当全部被拒但不抛 ConflictError
  const results = await Promise.allSettled([
    w.runtime.cancel(t.id), w.runtime.cancel(t.id), w.runtime.cancel(t.id),
  ]);
  const reasons = results.map((r) => r.status === 'rejected' ? String(r.reason) : 'ok');
  assert.ok(reasons.every((r) => !r.includes('ConflictError')), `不该出现并发冲突：${reasons}`);
});
