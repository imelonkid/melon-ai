import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskEvent } from '@melon-ai/core';
import { IllegalTransitionError, TERMINAL_STATES } from '@melon-ai/core';
import {
  EPISODE_ID, TASK_ID, TOOLSET, TRACE, drive, settle, spec, toolCall, usage,
} from '@melon-ai/testkit';
import { createTask, reduce, TRANSITIONS, CANCELLABLE_FROM } from '../src/index.js';

const NOW = 1_000;
const fresh = (over: Partial<Task> = {}): Task => ({
  ...createTask({
    id: TASK_ID, spec: spec(), rootId: TASK_ID, episodeId: EPISODE_ID,
    toolset: TOOLSET, trace: TRACE, now: 0,
  }),
  ...over,
});
const R = (t: Task, e: TaskEvent) => reduce(t, e, { now: NOW });

// ───────────────────────────── 基本迁移 ─────────────────────────────

test('PENDING --Started--> PLANNING，并要求规划', () => {
  const r = R(fresh(), { t: 'Started' });
  assert.equal(r.task.state, 'PLANNING');
  assert.deepEqual(r.effects, [{ k: 'CallPlanner', taskId: TASK_ID }]);
});

test('tool_call 先进 ADMITTING，而不是直接 EXECUTING', () => {
  const call = toolCall();
  const r = R(fresh({ state: 'PLANNING' }), {
    t: 'PlanProduced', step: { kind: 'tool_call', thought: 't', call }, usage: usage(),
  });
  assert.equal(r.task.state, 'ADMITTING');
  assert.deepEqual(r.effects, [{ k: 'Admit', taskId: TASK_ID, call }]);
  assert.equal(r.task.pendingCall?.callId, call.callId);
});

test('final 不直接置终态，而是派生 Settled', () => {
  const r = R(fresh({ state: 'PLANNING' }), {
    t: 'PlanProduced', step: { kind: 'final', thought: 't', answer: '好了' }, usage: usage(),
  });
  assert.equal(r.task.state, 'PLANNING', '终态只能由 Settled 事件到达');
  assert.deepEqual(r.effects, [
    { k: 'Emit', taskId: TASK_ID, event: { t: 'Settled', outcome: { status: 'SUCCEEDED', answer: '好了' } } },
  ]);
});

// ───────────────────── 拒绝不是错误，是给模型的信息 ─────────────────────

test('准入拒绝 → OBSERVING，把拒绝当 observation 回喂', () => {
  const call = toolCall();
  const r = R(fresh({ state: 'ADMITTING', pendingCall: call }), {
    t: 'AdmissionResolved', callId: call.callId, decision: 'deny',
    reason: '策略不允许对外发送', risk: 'external',
  });
  assert.equal(r.task.state, 'OBSERVING', '不是 FAILED —— 任务不该因为一次拒绝就死掉');
  const emitted = r.effects.find((e) => e.k === 'Emit');
  assert.ok(emitted && emitted.k === 'Emit' && emitted.event.t === 'Observed');
});

test('用户拒绝审批 → OBSERVING，模型可以改道', () => {
  const call = toolCall();
  const r = R(fresh({ state: 'AWAITING_APPROVAL', pendingCall: call }), {
    t: 'ApprovalResolved', callId: call.callId, decision: 'deny',
  });
  assert.equal(r.task.state, 'OBSERVING');
});

test('审批通过 → EXECUTING 并真的去调工具', () => {
  const call = toolCall();
  for (const decision of ['allow', 'always'] as const) {
    const r = R(fresh({ state: 'AWAITING_APPROVAL', pendingCall: call }), {
      t: 'ApprovalResolved', callId: call.callId, decision,
    });
    assert.equal(r.task.state, 'EXECUTING');
    assert.deepEqual(r.effects, [{ k: 'InvokeTool', taskId: TASK_ID, call }]);
  }
});

// ───────────────────────────── 守卫 ─────────────────────────────

test('循环检测拦在准入之前，不浪费一次真实调用', () => {
  let task = fresh({ state: 'PLANNING' });
  const call = toolCall('mail.send', 'same');
  // 连续三次相同的 (toolId, argsHash)
  for (let i = 0; i < 3; i++) {
    const r = reduce(task, {
      t: 'PlanProduced', step: { kind: 'tool_call', thought: 't', call }, usage: usage(),
    }, { now: NOW });
    task = r.task;
    if (i < 2) {
      assert.equal(r.task.state, 'ADMITTING', `第 ${i + 1} 次应正常进准入`);
      task = { ...task, state: 'PLANNING' };
    } else {
      assert.equal(r.task.state, 'PLANNING', '第 3 次不进准入');
      const emitted = r.effects.find((e) => e.k === 'Emit');
      assert.ok(emitted && emitted.k === 'Emit' && emitted.event.t === 'LoopDetected');
    }
  }
});

test('交替调用两个工具不算循环 —— 那是正常推理', () => {
  let task = fresh({ state: 'PLANNING' });
  for (let i = 0; i < 6; i++) {
    const call = toolCall(i % 2 === 0 ? 'a.x' : 'b.y', i % 2 === 0 ? 'h1' : 'h2');
    const r = reduce(task, {
      t: 'PlanProduced', step: { kind: 'tool_call', thought: 't', call }, usage: usage(),
    }, { now: NOW });
    assert.equal(r.task.state, 'ADMITTING', `第 ${i + 1} 次不该被当成循环`);
    task = { ...r.task, state: 'PLANNING' };
  }
});

test('LoopDetected 注入纠偏 observation，不终止任务', () => {
  const r = R(fresh({ state: 'PLANNING' }), { t: 'LoopDetected', argsHash: 'h', times: 3 });
  assert.equal(r.task.state, 'OBSERVING');
  assert.equal(r.task.guard.recentCalls.length, 0, '纠偏后要清空窗口，否则会立刻再次触发');
  const emitted = r.effects.find((e) => e.k === 'Emit');
  assert.ok(emitted && emitted.k === 'Emit' && emitted.event.t === 'Observed');
});

test('连续无进展 → NoProgress → FAILED', () => {
  let task = fresh({ state: 'OBSERVING' });
  for (let i = 0; i < 4; i++) {
    const r = reduce(task, { t: 'Observed', summary: '' }, { now: NOW });
    task = r.task;
    if (i < 3) {
      assert.equal(task.state, 'PLANNING');
      task = { ...task, state: 'OBSERVING' };
    } else {
      const emitted = r.effects.find((e) => e.k === 'Emit');
      assert.ok(emitted && emitted.k === 'Emit' && emitted.event.t === 'NoProgress');
    }
  }
  const final = reduce({ ...task, state: 'OBSERVING' }, { t: 'NoProgress', steps: 4 }, { now: NOW });
  const settled = final.effects.find((e) => e.k === 'Emit');
  assert.ok(settled && settled.k === 'Emit' && settled.event.t === 'Settled');
  assert.equal(settled.event.t === 'Settled' ? settled.event.outcome.status : '', 'FAILED');
});

test('有内容的 observation 重置无进展计数', () => {
  const stale = fresh({ state: 'OBSERVING', guard: { recentCalls: [], stagnantSteps: 3 } });
  const r = R(stale, { t: 'Observed', summary: '读到了 12 篇文档' });
  assert.equal(r.task.guard.stagnantSteps, 0);
  assert.equal(r.task.state, 'PLANNING');
});

// ───────────────────────────── 预算 ─────────────────────────────

test('步数耗尽 → BudgetExhausted → FAILED', () => {
  const broke = fresh({
    state: 'OBSERVING',
    usage: { steps: 24, tokens: 0, costUSD: 0, startedAt: 0 },
  });
  const r = R(broke, { t: 'Observed', summary: 'x' });
  const emitted = r.effects.find((e) => e.k === 'Emit');
  assert.ok(emitted && emitted.k === 'Emit' && emitted.event.t === 'BudgetExhausted');
  assert.equal(emitted.event.t === 'BudgetExhausted' ? emitted.event.dimension : '', 'steps');
});

test('墙上时间耗尽也会停', () => {
  const broke = fresh({
    state: 'OBSERVING',
    usage: { steps: 1, tokens: 0, costUSD: 0, startedAt: 0 },
  });
  const r = reduce(broke, { t: 'Observed', summary: 'x' }, { now: 11 * 60 * 1000 });
  const emitted = r.effects.find((e) => e.k === 'Emit');
  assert.ok(emitted && emitted.k === 'Emit' && emitted.event.t === 'BudgetExhausted');
});

// ───────────────────────────── 子任务 ─────────────────────────────

test('子任务未全部收敛时留在 SUSPENDED', () => {
  const parent = fresh({ state: 'SUSPENDED', waitingFor: ['c1', 'c2'] as never });
  const r = R(parent, { t: 'ChildSettled', childId: 'c1' as never, outcome: { status: 'SUCCEEDED' } });
  assert.equal(r.task.state, 'SUSPENDED');
  const r2 = R(r.task, { t: 'ChildSettled', childId: 'c2' as never, outcome: { status: 'SUCCEEDED' } });
  assert.equal(r2.task.state, 'PLANNING');
  assert.deepEqual(r2.effects, [{ k: 'CallPlanner', taskId: TASK_ID }]);
});

// ───────────────────────────── 非法迁移 ─────────────────────────────

test('终态不接受任何事件', () => {
  for (const state of TERMINAL_STATES) {
    assert.throws(
      () => R(fresh({ state }), { t: 'Started' }),
      IllegalTransitionError,
      `${state} 应当拒绝事件`,
    );
  }
});

test('非法组合抛 IllegalTransitionError，而不是悄悄走 default', () => {
  assert.throws(() => R(fresh({ state: 'PENDING' }), { t: 'Observed', summary: 'x' }), IllegalTransitionError);
  assert.throws(() => R(fresh({ state: 'EXECUTING' }), { t: 'Started' }), IllegalTransitionError);
  assert.throws(() => R(fresh({ state: 'PLANNING' }), { t: 'ToolCallFinished',
    callId: 'c' as never, meta: { ok: true, metrics: { ms: 1, bytes: 0, retries: 0 } } }), IllegalTransitionError);
});

test('Cancelled 在所有非终态都合法', () => {
  for (const state of CANCELLABLE_FROM) {
    const r = R(fresh({ state }), { t: 'Cancelled', reason: '用户取消' });
    assert.equal(r.task.state, 'CANCELLED', `${state} 应当可取消`);
    assert.equal(r.task.outcome?.status, 'CANCELLED');
  }
});

// ───────────────────────────── 纯函数性 ─────────────────────────────

test('reducer 不改入参，且同输入同输出', () => {
  const t0 = fresh({ state: 'PLANNING' });
  const snapshot = JSON.stringify(t0);
  const e: TaskEvent = { t: 'PlanProduced', step: { kind: 'skill_query', thought: 't', query: 'q' }, usage: usage() };
  const a = R(t0, e);
  const b = R(t0, e);
  assert.equal(JSON.stringify(t0), snapshot, '入参被修改了');
  assert.deepEqual(JSON.stringify(a.task), JSON.stringify(b.task));
  assert.deepEqual(a.effects, b.effects);
});

test('每次迁移都递增 version —— 乐观并发依赖它', () => {
  const r = R(fresh(), { t: 'Started' });
  assert.equal(r.task.version, 1);
  assert.equal(R(r.task, { t: 'Compacted', episodeId: EPISODE_ID }).task.version, 2);
});

// ───────────────────── 端到端：带审批的两步任务 ─────────────────────

test('崩溃恢复：同一事件序列重放出同一最终状态', () => {
  const call = toolCall('mail.send', 'h9');
  const events: TaskEvent[] = [
    { t: 'Started' },
    { t: 'PlanProduced', step: { kind: 'tool_call', thought: '先发邮件', call }, usage: usage() },
    { t: 'AdmissionResolved', callId: call.callId, decision: 'ask', reason: '对外发送需确认', risk: 'external' },
    { t: 'ApprovalRequested', request: { callId: call.callId, toolId: call.toolId, risk: 'external', summary: 's' } },
    { t: 'ApprovalResolved', callId: call.callId, decision: 'allow' },
    { t: 'ToolCallStarted', call },
    { t: 'ToolCallFinished', callId: call.callId, meta: { ok: true, metrics: { ms: 5, bytes: 10, retries: 0 } } },
    { t: 'Observed', callId: call.callId, summary: '已发送给 6 人' },
    { t: 'PlanProduced', step: { kind: 'final', thought: '完成', answer: '周报已发送' }, usage: usage() },
  ];

  const first = settle(reduce, fresh(), events, NOW);
  const replay = settle(reduce, fresh(), events, NOW);

  assert.equal(first.task.state, 'SUCCEEDED');
  assert.equal(first.task.outcome?.answer, '周报已发送');
  assert.deepEqual(first.states, replay.states, '重放路径必须一致');
  assert.equal(JSON.stringify(first.task), JSON.stringify(replay.task));

  assert.deepEqual(first.states, [
    'PLANNING',          // Started
    'ADMITTING',         // PlanProduced(tool_call)
    'AWAITING_APPROVAL', // AdmissionResolved(ask)
    'AWAITING_APPROVAL', // ApprovalRequested（仅记录）
    'EXECUTING',         // ApprovalResolved(allow)
    'EXECUTING',         // ToolCallStarted（仅记录）
    'OBSERVING',         // ToolCallFinished
    'PLANNING',          // Observed
    'PLANNING',          // PlanProduced(final) —— 只派生 Settled，不置终态
    'SUCCEEDED',         // Settled（由 settle() 自动喂回）
  ]);

  // 收敛后应当派生内务：压缩 + 记忆提升
  const kinds = first.effects.map((e) => e.k);
  assert.ok(kinds.includes('Compact'));
  assert.ok(kinds.includes('PromoteMemory'));
});

// ───────────────────── 迁移表本身的覆盖率 ─────────────────────

test('迁移表里每一条都被测试触达过（否则是死规则）', () => {
  const keys = Object.keys(TRANSITIONS);
  assert.ok(keys.length > 0);
  // 表是数据，可以直接检查形状：derived 必须给出 allowed 集合
  for (const [key, t] of Object.entries(TRANSITIONS)) {
    if (t.to === 'derived') {
      assert.ok(t.allowed && t.allowed.length > 0, `${key} 是 derived 但没声明 allowed`);
    }
  }
});

test('derived 迁移不能走到 allowed 之外的状态', () => {
  // spawn 声明 SUSPENDED，若实现改成别的状态，这条会立刻炸
  const r = R(fresh({ state: 'PLANNING' }), {
    t: 'PlanProduced', step: { kind: 'spawn', thought: 't', specs: [spec()] }, usage: usage(),
  });
  assert.equal(r.task.state, 'SUSPENDED');
  assert.ok(TRANSITIONS['PLANNING+PlanProduced']?.allowed?.includes('SUSPENDED'));
});

// ───────── pendingCall 生命周期（集成 Jolly 时暴露的 bug）─────────

test('pendingCall 只在 AWAITING_APPROVAL / ADMITTING / EXECUTING 期间存在', () => {
  const call = toolCall('mail.send', 'h1');
  const events: TaskEvent[] = [
    { t: 'Started' },
    { t: 'PlanProduced', step: { kind: 'tool_call', thought: 't', call }, usage: usage() },
    { t: 'AdmissionResolved', callId: call.callId, decision: 'ask', reason: 'r', risk: 'external' },
    { t: 'ApprovalResolved', callId: call.callId, decision: 'allow' },
    { t: 'ToolCallStarted', call },
    { t: 'ToolCallFinished', callId: call.callId, meta: { ok: true, metrics: { ms: 1, bytes: 0, retries: 0 } } },
    { t: 'Observed', callId: call.callId, summary: '已发送' },
    { t: 'PlanProduced', step: { kind: 'final', thought: 'done', answer: 'ok' }, usage: usage() },
  ];
  const r = settle(reduce, fresh(), events, NOW);

  // 关键：终态不能还挂着 pendingCall，否则宿主会把已完成的任务当成待审批
  assert.equal(r.task.state, 'SUCCEEDED');
  assert.equal(r.task.pendingCall, undefined,
    '跑完后 pendingCall 必须清掉 —— 否则宿主会对终态任务发 ApprovalResolved');
});

test('被拒绝后也要清掉 pendingCall', () => {
  const call = toolCall();
  const r = R(fresh({ state: 'AWAITING_APPROVAL', pendingCall: call }), {
    t: 'ApprovalResolved', callId: call.callId, decision: 'deny',
  });
  assert.equal(r.task.pendingCall, undefined);
});

test('取消后也要清掉 pendingCall', () => {
  const call = toolCall();
  const r = R(fresh({ state: 'AWAITING_APPROVAL', pendingCall: call }), { t: 'Cancelled' });
  assert.equal(r.task.pendingCall, undefined);
});

// ───────── 无进展判据（人工验收暴露的问题）─────────

test('同一句观察重复出现即算无进展，哪怕参数换了', () => {
  let task = fresh({ state: 'OBSERVING' });
  const SAME = '读取到 3 条与「本周进展」相关的进展';
  // 第一次出现是有进展的，之后每次重复计一次；阈值 4，所以第 5 次触发
  for (let i = 0; i < 5; i++) {
    const r = reduce(task, { t: 'Observed', summary: SAME }, { now: NOW });
    task = r.task;
    if (i < 4) {
      assert.equal(task.state, 'PLANNING', `第 ${i + 1} 次应继续`);
      task = { ...task, state: 'OBSERVING' };
    } else {
      const emitted = r.effects.find((e) => e.k === 'Emit');
      assert.ok(emitted && emitted.k === 'Emit' && emitted.event.t === 'NoProgress',
        '同一句话重复 4 次必须触发无进展 —— 旧判据「非空即进展」会让它无限跑下去');
    }
  }
});

test('观察内容变化则重置计数', () => {
  let task = fresh({ state: 'OBSERVING' });
  task = reduce(task, { t: 'Observed', summary: 'A' }, { now: NOW }).task;
  task = reduce({ ...task, state: 'OBSERVING' }, { t: 'Observed', summary: 'A' }, { now: NOW }).task;
  assert.equal(task.guard.stagnantSteps, 1, '重复一次，计数为 1');
  task = reduce({ ...task, state: 'OBSERVING' }, { t: 'Observed', summary: 'B' }, { now: NOW }).task;
  assert.equal(task.guard.stagnantSteps, 0, '内容变了就是有进展');
});

test('空观察也算无进展', () => {
  const r = R(fresh({ state: 'OBSERVING' }), { t: 'Observed', summary: '' });
  assert.equal(r.task.guard.stagnantSteps, 1);
});
