import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PolicyMode, Task, ToolCall, ToolDescriptor, ToolHandler } from '@melon-ai/core';
import { BUILTIN_TOOLS, ToolError, asSkillId, asToolId } from '@melon-ai/core';
import {
  ChainedRecorder, DEFAULT_RETENTION, assertRetention,
} from '@melon-ai/audit';
import { createTask } from '@melon-ai/task';
import {
  EPISODE_ID, FakeClock, InMemoryArtifactStore, InMemoryAuditSink, InMemoryGrantStore,
  InMemoryIdempotencyStore, NodeHasher, RecordingTracer, SeqIdGen, StaticToolResolver,
  StructuralValidator, TASK_ID, TOOLSET, TRACE, CapturingLogger, spec, toolCall,
} from '@melon-ai/testkit';
import { CircuitBreaker, SUMMARY_CHAR_LIMIT, ToolPipeline, canonicalJson } from '../src/index.js';

const MAIL = asToolId('mail.send');
const READER = asToolId('doc.read');

const desc = (over: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  id: MAIL, skillId: asSkillId('mail'), name: 'send',
  description: '发送邮件',
  input: { required: ['to'], properties: { to: { type: 'string' } } },
  risk: 'external', idempotent: false, scopeKeys: ['to'],
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  ...createTask({
    id: TASK_ID, spec: spec(), rootId: TASK_ID, episodeId: EPISODE_ID,
    toolset: TOOLSET, trace: TRACE, now: 0,
  }),
  ...over,
});

async function harness(opts: {
  handler?: ToolHandler;
  descriptor?: ToolDescriptor;
  enabled?: boolean;
  idempotency?: boolean;
} = {}) {
  const clock = new FakeClock(1000);
  const hasher = new NodeHasher();
  const sink = new InMemoryAuditSink();
  const audit = new ChainedRecorder({ sink, hasher, clock });
  await audit.resume();
  const grants = new InMemoryGrantStore();
  const artifacts = new InMemoryArtifactStore(() => clock.now());
  const idem = new InMemoryIdempotencyStore();
  const logger = new CapturingLogger();
  const resolver = new StaticToolResolver().add({
    descriptor: opts.descriptor ?? desc(),
    handler: opts.handler ?? (async () => ({ summary: '已发送' })),
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
  });
  const pipeline = new ToolPipeline({
    resolver, validator: new StructuralValidator(), grants, artifacts, audit,
    clock, hasher, tracer: new RecordingTracer(new SeqIdGen()), logger,
    ...(opts.idempotency ? { idempotency: idem } : {}),
    sleep: async () => {},
    execute: { timeoutMs: 50, maxRetries: 2, backoffBaseMs: 0 },
  });
  return { pipeline, sink, grants, artifacts, idem, logger, clock, resolver, audit };
}

const ARGS = { to: '产品组', subject: '周报' };
const call = () => ({ ...toolCall('mail.send', 'h1'), args: ARGS });

/**
 * 把两段串起来，模拟运行时的驱动方式。
 * 返回形状刻意沿用旧的 executed / needs-approval，让测试意图保持可读。
 */
async function invokeAll(
  h: Awaited<ReturnType<typeof harness>>,
  t: Task,
  c: ToolCall,
  mode: PolicyMode,
) {
  const a = await h.pipeline.admit(t, c, mode);
  if (a.kind === 'ask') return { kind: 'needs-approval' as const, request: a.request, admission: a.admission };
  if (a.kind === 'reject') return { kind: 'executed' as const, result: a.result, admission: a.admission };
  return { kind: 'executed' as const, result: await h.pipeline.execute(t, c), admission: a.admission };
}

// ───────────────────── 段的顺序 ─────────────────────

test('①解析失败当成可修复错误回喂，而不是致命错误', async () => {
  const h = await harness();
  const out = await invokeAll(h, task(), { ...toolCall('nope.tool'), args: {} }, 'all-auto');
  assert.equal(out.kind, 'executed');
  const r = out.kind === 'executed' ? out.result : null;
  assert.equal(r?.error?.code, 'INVALID_ARGS', '模型可能幻觉工具名，应让它重新找');
  assert.match(r!.summary, /不存在/);
});

test('②校验失败 → INVALID_ARGS，且工具根本没被执行', async () => {
  let ran = false;
  const h = await harness({ handler: async () => { ran = true; return { summary: 'x' }; } });
  const out = await invokeAll(h, task(), { ...toolCall('mail.send'), args: { subject: '无收件人' } }, 'all-auto');
  assert.equal(out.kind, 'executed');
  assert.equal(out.kind === 'executed' ? out.result.error?.code : '', 'INVALID_ARGS');
  assert.equal(ran, false);
});

test('③未授权的技能 → 直接 deny，不弹审批', async () => {
  const h = await harness({ enabled: false });
  const out = await invokeAll(h, task(), call(), 'ask');
  assert.equal(out.kind, 'executed', '不该走 needs-approval');
  assert.equal(out.kind === 'executed' ? out.result.error?.code : '', 'DENIED');
});

test('③external + ask 策略 → needs-approval，工具不执行', async () => {
  let ran = false;
  const h = await harness({ handler: async () => { ran = true; return { summary: 'x' }; } });
  const c = call();
  const out = await invokeAll(h, task(), c, 'ask');
  assert.equal(out.kind, 'needs-approval');
  assert.equal(ran, false, '等审批期间绝不能先执行');
  assert.equal(out.kind === 'needs-approval' ? out.request.risk : '', 'external');
  assert.equal(out.kind === 'needs-approval' ? out.request.callId : '', c.callId,
    '审批请求必须带回同一个 callId，否则审批结果对不上调用');
});

test('③命中 scope 相符的 always 授权 → 直接执行', async () => {
  const h = await harness();
  await h.grants.put({ agentId: task().agentId, toolId: MAIL, scope: 'to=产品组', grantedAt: 0 });
  const out = await invokeAll(h, task(), call(), 'ask');
  assert.equal(out.kind, 'executed');
  assert.equal(out.kind === 'executed' ? out.result.ok : false, true);
  assert.equal(out.kind === 'executed' ? out.admission.basis.gate : '', 'grant');
});

test('③换了收件人则授权不命中，重新要求审批', async () => {
  const h = await harness();
  await h.grants.put({ agentId: task().agentId, toolId: MAIL, scope: 'to=产品组', grantedAt: 0 });
  const out = await invokeAll(h, task(), { ...call(), args: { to: '全体员工' } }, 'ask');
  assert.equal(out.kind, 'needs-approval');
});

test('③污点下写记忆强制审批，即使策略是 all-auto', async () => {
  const h = await harness({
    descriptor: desc({ id: BUILTIN_TOOLS.MEMORY_WRITE, risk: 'write', scopeKeys: [], input: {} }),
  });
  const out = await invokeAll(h, 
    task({ tainted: true }),
    { ...toolCall(BUILTIN_TOOLS.MEMORY_WRITE), args: {} },
    'all-auto',
  );
  assert.equal(out.kind, 'needs-approval');
  assert.equal(out.kind === 'needs-approval' ? out.admission.basis.gate : '', 'taint');
});

// ───────────────────── ④ 执行 ─────────────────────

test('④只重试 UPSTREAM，不重试 DENIED', async () => {
  let calls = 0;
  const up = await harness({
    handler: async () => { calls++; throw new ToolError('UPSTREAM', '上游 502'); },
  });
  await invokeAll(up, task(), call(), 'all-auto');
  assert.equal(calls, 3, '1 次 + 2 次重试');

  let denied = 0;
  const dn = await harness({
    handler: async () => { denied++; throw new ToolError('DENIED', '对端拒绝'); },
  });
  await invokeAll(dn, task(), call(), 'all-auto');
  assert.equal(denied, 1, 'DENIED 不该重试，重试必然再失败');
});

test('④超时归为 UPSTREAM 并可重试', async () => {
  let calls = 0;
  const h = await harness({
    handler: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 200));
      return { summary: '太慢了' };
    },
  });
  const out = await invokeAll(h, task(), call(), 'all-auto');
  assert.equal(out.kind === 'executed' ? out.result.error?.code : '', 'UPSTREAM');
  assert.equal(calls, 3);
});

test('④重试次数进 metrics', async () => {
  const h = await harness({
    handler: async () => { throw new ToolError('RATE_LIMITED', '限流'); },
  });
  const out = await invokeAll(h, task(), call(), 'all-auto');
  assert.equal(out.kind === 'executed' ? out.result.metrics.retries : -1, 2);
});

test('熔断器：连续失败后打开，冷却后半开放一次探测', () => {
  const b = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
  assert.equal(b.check('t', 0), null);
  b.onFailure('t', 0);
  assert.equal(b.check('t', 0), null, '一次失败还不该熔断');
  b.onFailure('t', 0);
  assert.equal(b.stateOf('t'), 'open');
  assert.ok(b.check('t', 50) !== null, '冷却期内拦住');
  assert.equal(b.check('t', 150), null, '冷却后半开，放一次探测');
  b.onFailure('t', 150);
  assert.equal(b.stateOf('t'), 'open', '半开时再失败应立刻回到打开，不等攒够阈值');
  b.onSuccess('t');
  assert.equal(b.stateOf('t'), 'closed');
});

// ───────────────────── ⑤ 归一化 ─────────────────────

test('⑤超长 summary 被截断，且原文落成 artifact 不丢', async () => {
  const long = 'あ'.repeat(SUMMARY_CHAR_LIMIT + 500);
  const h = await harness({ handler: async () => ({ summary: long }) });
  const out = await invokeAll(h, task(), call(), 'all-auto');
  const r = out.kind === 'executed' ? out.result : null;
  assert.ok(r!.summary.length <= SUMMARY_CHAR_LIMIT);
  assert.match(r!.summary, /已截断/);
  assert.ok(r!.artifactRef, '必须留下句柄，否则原文就丢了');
  assert.equal(h.artifacts.text(r!.artifactRef!).length, long.length);
});

test('⑤工具自己落的 artifact 会被保留', async () => {
  const h = await harness({
    handler: async (_a, cx) => {
      const ref = await cx.putArtifact('12 篇文档全文', { mime: 'text/plain', summary: '全文' });
      return { summary: '读了 12 篇文档', artifactRef: ref };
    },
  });
  const out = await invokeAll(h, task(), call(), 'all-auto');
  const r = out.kind === 'executed' ? out.result : null;
  assert.equal(r!.summary, '读了 12 篇文档');
  assert.equal(h.artifacts.text(r!.artifactRef!), '12 篇文档全文');
});

test('⑤失败也有 summary —— 它要作为 observation 回喂', async () => {
  const h = await harness({
    handler: async () => { throw new ToolError('NOT_FOUND', '收件人不存在', { hint: '换个收件人' }); },
  });
  const out = await invokeAll(h, task(), call(), 'all-auto');
  const r = out.kind === 'executed' ? out.result : null;
  assert.match(r!.summary, /NOT_FOUND/);
  assert.match(r!.summary, /换个收件人/);
});

// ───────────────────── ⑥ 记录 ─────────────────────

test('⑥准入与执行各写一条审计，且哈希链完整', async () => {
  const h = await harness();
  await invokeAll(h, task(), call(), 'all-auto');
  const actions = h.sink.rows.map((r) => r.action);
  assert.deepEqual(actions, ['approval.decide', 'tool.invoke']);
  assert.equal(await h.audit.verify(), null);
});

test('⑥审计只存引用与维度，不存参数内容', async () => {
  const h = await harness();
  await invokeAll(h, task(), call(), 'all-auto');
  const json = JSON.stringify(h.sink.rows);
  assert.ok(!json.includes('周报'), '参数内容（subject）不该出现在审计里');
  assert.ok(json.includes('mail.send'), '工具名作为维度应该在');
  assert.equal(h.sink.rows[0]!.resource.kind, 'tool-call');
  assert.ok(h.sink.rows[0]!.resource.contentHash, 'contentHash 必须有，否则查不出参数被换');
});

test('⑥准入依据落进审计 basis', async () => {
  const h = await harness();
  await invokeAll(h, task(), call(), 'ask');
  const rec = h.sink.rows.find((r) => r.action === 'approval.decide');
  assert.equal(rec?.outcome, 'ask');
  assert.equal(rec?.basis?.gate, 'matrix');
  assert.equal(rec?.basis?.mode, 'ask');
});

// ───────────────────── 幂等 ─────────────────────

test('幂等短路：重放不会真的再发一次', async () => {
  let sent = 0;
  const h = await harness({
    handler: async () => { sent++; return { summary: '已发送' }; },
    idempotency: true,
  });
  const c = call();
  await invokeAll(h, task(), c, 'all-auto');
  await invokeAll(h, task(), c, 'all-auto');
  assert.equal(sent, 1, '同一个 callId 重放必须短路 —— effect 重跑不能重复发邮件');
  assert.equal(h.idem.hits.length, 1);
});

test('幂等工具不分配 key，不写缓存', async () => {
  let n = 0;
  const h = await harness({
    descriptor: desc({ id: READER, risk: 'read', idempotent: true, input: {}, scopeKeys: [] }),
    handler: async () => { n++; return { summary: 'ok' }; },
    idempotency: true,
  });
  const c = { ...toolCall('doc.read'), args: {} };
  await invokeAll(h, task(), c, 'all-auto');
  await invokeAll(h, task(), c, 'all-auto');
  assert.equal(n, 2, '幂等工具本来就能重复调，不必走缓存');
  assert.equal(h.idem.hits.length, 0);
});

// ───────────────────── resume ─────────────────────

test('审批通过后 execute 直接执行，不重判准入', async () => {
  const h = await harness();
  const out = await invokeAll(h, task(), call(), 'ask');
  assert.equal(out.kind, 'needs-approval');
  const r = await h.pipeline.execute(task(), call());
  assert.equal(r.ok, true);
  // 只有第一次 invoke 写了 approval.decide；resume 只写 tool.invoke
  assert.deepEqual(h.sink.rows.map((x) => x.action), ['approval.decide', 'tool.invoke']);
});

// ───────────────────── 辅助 ─────────────────────

test('canonicalJson 键序无关，且区分 null 与 undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({ a: undefined }));
});

test('保留策略在管线之外也能校验', () => {
  assert.doesNotThrow(() => assertRetention(DEFAULT_RETENTION));
});

// ───────── artifact 读取的任务范围（§2.7）─────────

test('工具可以读回自己写的 artifact', async () => {
  const h = await harness({
    handler: async (_a, cx) => {
      const ref = await cx.putArtifact('全文内容', { mime: 'text/plain', summary: 's' });
      const back = await cx.readArtifact(ref);
      return { summary: `读回：${back}` };
    },
  });
  const out = await invokeAll(h, task(), call(), 'all-auto');
  assert.equal(out.kind === 'executed' ? out.result.summary : '', '读回：全文内容');
});

test('跨任务读取被拒 —— 句柄是可猜的，不校验等于开横向读取的口子', async () => {
  const h = await harness({ handler: async () => ({ summary: 'x' }) });
  // 造一个属于别的任务的 artifact
  const foreign = await h.artifacts.put('别人的秘密' as never, '别人的秘密', {
    mime: 'text/plain', summary: 's',
  });
  const h2 = await harness({
    handler: async (_a, cx) => ({ summary: await cx.readArtifact(foreign) }),
  });
  const out = await invokeAll(h2, task(), call(), 'all-auto');
  assert.equal(out.kind === 'executed' ? out.result.error?.code : '', 'NOT_FOUND');
});
