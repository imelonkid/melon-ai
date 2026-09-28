import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, GenerateRequest, GenerateResult, ModelTool, PlanInput } from '@melon-ai/core';
import { asAgentId, asEpisodeId, asSkillId, asTaskId } from '@melon-ai/core';
import { KeywordIntentClassifier, REACT_PROMPT, ReActPlanner } from '../src/index.js';

class StubModel implements ChatModel {
  readonly id = 'stub';
  readonly capabilities = {
    contextWindow: 200_000, maxOutputTokens: 8000, tools: true, jsonSchema: true, promptCache: true,
  };
  readonly requests: GenerateRequest[] = [];
  constructor(private readonly script: readonly Partial<GenerateResult>[]) {}
  private i = 0;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const item = this.script[this.i++] ?? { text: '完成' };
    return {
      text: item.text ?? '', usage: { inputTokens: 1, outputTokens: 1 },
      modelId: this.id, stopReason: item.stopReason ?? 'stop',
      ...(item.toolCalls ? { toolCalls: item.toolCalls } : {}),
    };
  }
}

const router = (m: ChatModel) => ({
  select: async () => ({ primary: m, fallbacks: [], reason: 'stub', egress: [m.id] }),
  tokenizerFor: () => ({ count: () => 1, countMessages: () => 1 }),
});

const TOOLS: ModelTool[] = [
  { name: 'mail.send', description: '发邮件', input: { type: 'object', required: ['to'] } },
];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  task: {
    id: asTaskId('t1'), rootId: asTaskId('t1'), agentId: asAgentId('a'), kind: 'conversation',
    goal: '汇总本周进展并发送周报', state: 'PLANNING', trigger: { type: 'manual' },
    budget: { maxSteps: 24, maxTokens: 1e6, maxCostUSD: 1, maxWallClockMs: 1e6 },
    usage: { steps: 0, tokens: 0, costUSD: 0, startedAt: 0 },
    toolset: { takenAt: 0, skills: [{ id: asSkillId('mail'), version: '1' }] },
    episodeId: asEpisodeId('e1'), trace: { traceId: 'tr' as never, spanId: 'sp' as never },
    tainted: false, guard: { recentCalls: [], stagnantSteps: 0 },
    createdAt: 0, updatedAt: 0, version: 0,
  },
  context: { messages: [{ role: 'user', content: '帮我发周报' }], tools: [], slots: [], totalTokens: 10, window: 200_000, watermark: 0.7 },
  availableTools: TOOLS,
  trace: { traceId: 'tr' as never, spanId: 'sp' as never },
  ...over,
});

const sig = new AbortController().signal;

test('模型选了工具 → tool_call', async () => {
  const m = new StubModel([{
    text: '先发邮件', stopReason: 'tool',
    toolCalls: [{ id: 'tu_1', name: 'mail.send', args: { to: '产品组' } }],
  }]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input(), sig);
  assert.equal(step.kind, 'tool_call');
  if (step.kind === 'tool_call') {
    assert.equal(step.call.toolId, 'mail.send');
    assert.deepEqual(step.call.args, { to: '产品组' });
    assert.ok(step.call.argsHash.length > 0, '必须有 argsHash —— 循环检测与幂等都靠它');
  }
});

test('模型没选工具 → final', async () => {
  const m = new StubModel([{ text: '已经完成了。' }]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input(), sig);
  assert.equal(step.kind, 'final');
  assert.equal(step.kind === 'final' ? step.answer : '', '已经完成了。');
});

test('相同参数产生相同 argsHash —— 否则循环检测失效', async () => {
  const mk = () => new StubModel([{
    stopReason: 'tool', toolCalls: [{ id: 'x', name: 'mail.send', args: { b: 2, a: 1 } }],
  }]);
  const p = new ReActPlanner({ router: router(mk()) });
  const a = await p.plan(input(), sig);
  const p2 = new ReActPlanner({ router: router(mk()) });
  const b = await p2.plan(input(), sig);
  assert.equal(
    a.kind === 'tool_call' ? a.call.argsHash : '',
    b.kind === 'tool_call' ? b.call.argsHash : 'x',
  );
});

test('闲聊短路：完全不带工具', async () => {
  const m = new StubModel([{ text: '你好呀' }]);
  const p = new ReActPlanner({ router: router(m), classifier: new KeywordIntentClassifier() });
  await p.plan(input({ task: { ...input().task, goal: '你好' } }), sig);
  assert.equal(m.requests[0]?.tools, undefined, '闲聊不该注入任何 tool schema');
});

test('任务型请求带工具', async () => {
  const m = new StubModel([{ text: '好的' }]);
  const p = new ReActPlanner({ router: router(m), classifier: new KeywordIntentClassifier() });
  await p.plan(input(), sig);
  assert.equal(m.requests[0]?.tools?.length, 1);
});

test('已经动过手的任务不再重新分类 —— 中途判成闲聊会把工具收走', async () => {
  const m = new StubModel([{ text: 'ok' }]);
  const p = new ReActPlanner({
    router: router(m),
    classifier: { classify: async () => 'chat' as const },
  });
  const t = input().task;
  await p.plan(input({ task: { ...t, goal: '你好', usage: { ...t.usage, steps: 3 } } }), sig);
  assert.equal(m.requests[0]?.tools?.length, 1, '跑过工具的任务必须继续带工具');
});

test('分类器抛错时按 task 走，不让请求变成空谈', async () => {
  const m = new StubModel([{ text: 'ok' }]);
  const p = new ReActPlanner({
    router: router(m),
    classifier: { classify: async () => { throw new Error('boom'); } },
  });
  await p.plan(input(), sig);
  assert.equal(m.requests[0]?.tools?.length, 1);
});

test('系统提示排在最前且打了缓存断点', async () => {
  const m = new StubModel([{ text: 'ok' }]);
  await new ReActPlanner({ router: router(m) }).plan(input(), sig);
  const msgs = m.requests[0]!.messages;
  assert.equal(msgs[0]?.role, 'system');
  assert.equal(msgs[0]?.cacheBoundary, true, '缓存断点要打在最稳定的一段上');
});

test('被安全策略拦截 → final，不是崩溃', async () => {
  const m = new StubModel([{ text: '无法协助', stopReason: 'filtered' }]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input(), sig);
  assert.equal(step.kind, 'final');
});

test('上下文为空时不发空 messages', async () => {
  const m = new StubModel([{ text: 'ok' }]);
  await new ReActPlanner({ router: router(m) }).plan(
    input({ context: { messages: [], tools: [], slots: [], totalTokens: 0, window: 1000, watermark: 0.7 } }), sig,
  );
  assert.ok(m.requests[0]!.messages.length >= 2, '供应商会拒绝空 messages');
});

test('提示词有版本号 —— 它要进事件日志才能重放', () => {
  assert.equal(REACT_PROMPT.name, 'react.system');
  assert.ok(REACT_PROMPT.version.length > 0);
});
