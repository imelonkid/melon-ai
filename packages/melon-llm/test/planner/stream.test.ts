import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnswerDraft, ChatModel, GenerateRequest, GenerateResult, ModelTool, PlanInput } from '@melon-ai/core';
import { asAgentId, asEpisodeId, asSkillId, asTaskId } from '@melon-ai/core';
import { ReActPlanner } from '../../src/planner/index.js';

/** 按脚本分段「流式」吐字的假模型：每段回调一次到目前为止的全文。 */
class StreamingModel implements ChatModel {
  readonly id = 'stream-stub';
  readonly capabilities = {
    contextWindow: 200_000, maxOutputTokens: 8000, tools: true, jsonSchema: true, promptCache: true,
  };
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(private readonly script: readonly { chunks: readonly string[]; thinking?: readonly string[]; toolCalls?: GenerateResult['toolCalls'] }[]) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const item = this.script[this.i++] ?? { chunks: ['完成'] };
    let reasoning = '';
    for (const c of item.thinking ?? []) { reasoning += c; req.onReasoning?.(reasoning); }
    let text = '';
    for (const c of item.chunks) { text += c; req.onText?.(text); }
    return {
      text, ...(reasoning ? { reasoning } : {}), usage: { inputTokens: 1, outputTokens: 1 }, modelId: this.id,
      stopReason: item.toolCalls ? 'tool' : 'stop',
      ...(item.toolCalls ? { toolCalls: item.toolCalls } : {}),
    };
  }
}

const router = (m: ChatModel) => ({
  select: async () => ({ primary: m, fallbacks: [], reason: 'stub', egress: [m.id] }),
  tokenizerFor: () => ({ count: () => 1, countMessages: () => 1 }),
});

const MAIL: ModelTool = {
  name: 'mail.send', description: '发邮件', input: { type: 'object', required: ['to'] },
  risk: 'external', triggers: ['发邮件'],
};
const SEARCH: ModelTool = { name: 'web.search', description: '搜索', input: { type: 'object' } };

const input = (goal: string, tools: ModelTool[], drafts?: AnswerDraft[]): PlanInput => ({
  task: {
    id: asTaskId('t1'), rootId: asTaskId('t1'), agentId: asAgentId('a'), kind: 'conversation',
    goal, state: 'PLANNING', trigger: { type: 'manual' },
    budget: { maxSteps: 24, maxTokens: 1e6, maxCostUSD: 1, maxWallClockMs: 1e6 },
    usage: { steps: 1, tokens: 0, costUSD: 0, startedAt: 0 },
    toolset: { takenAt: 0, skills: [{ id: asSkillId('mail'), version: '1' }] },
    episodeId: asEpisodeId('e1'), trace: { traceId: 'tr' as never, spanId: 'sp' as never },
    tainted: false, guard: { recentCalls: [], stagnantSteps: 0 },
    createdAt: 0, updatedAt: 0, version: 0,
  },
  context: { messages: [{ role: 'user', content: goal }], tools: [], slots: [], totalTokens: 10, window: 200_000, watermark: 0.7 },
  availableTools: tools,
  trace: { traceId: 'tr' as never, spanId: 'sp' as never },
  ...(drafts ? { draft: (d: AnswerDraft) => drafts.push(d) } : {}),
});

const sig = new AbortController().signal;
const texts = (ds: AnswerDraft[]) => ds.flatMap((d) => (d.kind === 'text' ? [d.text] : []));

test('流式：回答边生成边交出去，每次是到目前为止的全文，最后一段就是最终回答', async () => {
  const drafts: AnswerDraft[] = [];
  const answer = '## 本周要点\n- 一、上线了新的检索服务\n- 二、修好了登录超时';
  const m = new StreamingModel([{ chunks: answer.match(/[\s\S]{1,8}/g)! }]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input('整理本周要点', [SEARCH], drafts), sig);
  assert.equal(step.kind, 'final');
  assert.ok(step.kind === 'final' && step.answer === answer);
  const ts = texts(drafts);
  assert.ok(ts.length >= 3, '应当分好几段');
  assert.ok(ts.every((t, i) => answer.startsWith(t) && (i === 0 || t.length >= ts[i - 1]!.length)), '每段都是全文的前缀，只增不减');
  assert.ok(drafts.every((d) => d.kind === 'text'));
});

test('流式：先说一句再调工具 —— 那段是过程话，撤回（reset: tool）', async () => {
  const drafts: AnswerDraft[] = [];
  const m = new StreamingModel([{ chunks: ['我先在网上搜一下最新的消息，', '然后整理给你看'], toolCalls: [{ id: 'c1', name: 'web.search', args: { q: 'x' } }] }]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input('查一下新闻', [SEARCH], drafts), sig);
  assert.equal(step.kind, 'tool_call');
  assert.deepEqual(drafts.at(-1), { kind: 'reset', reason: 'tool' });
});

test('流式：说「已发送」却没调工具 —— 那句话不显示，已经显示的撤回（reset: check），守卫照常纠正', async () => {
  const drafts: AnswerDraft[] = [];
  const m = new StreamingModel([
    { chunks: ['好的，我来处理这件事情，请稍等片刻。', '邮件已发送给 a@b.com'] },
    // 纠正那一轮必须调工具，不流式
    { chunks: [], toolCalls: [{ id: 'c1', name: 'mail.send', args: { to: 'a@b.com' } }] },
  ]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input('给 a@b.com 发封信说明天开会', [MAIL], drafts), sig);
  assert.ok(texts(drafts).every((t) => !t.includes('已发送')), '声称做成了的话一个字都不该显示出去');
  assert.deepEqual(drafts.at(-1), { kind: 'reset', reason: 'check' });
  assert.equal(step.kind, 'tool_call');
  assert.equal(m.requests[1]?.onText, undefined);
});

test('流式：「已发送」被切在两段之间 —— 只到「邮件已发」时也不显示', async () => {
  const drafts: AnswerDraft[] = [];
  const m = new StreamingModel([
    { chunks: ['好的，我来处理这件事情。', '邮件已发', '送给 a@b.com'] },
    { chunks: [], toolCalls: [{ id: 'c1', name: 'mail.send', args: { to: 'a@b.com' } }] },
  ]);
  await new ReActPlanner({ router: router(m) }).plan(input('给 a@b.com 发封信说明天开会', [MAIL], drafts), sig);
  assert.ok(texts(drafts).every((t) => !t.includes('已发')), `显示过：${JSON.stringify(texts(drafts))}`);
});

test('流式：拒绝后又用文字征求确认 —— 不显示，按用户的决定收尾', async () => {
  const drafts: AnswerDraft[] = [];
  const m = new StreamingModel([{ chunks: ['我理解你的顾虑，我们再核对一下内容吧。', '收件人对吗？确认后我就发送。'] }]);
  const inp = input('给 a@b.com 发封信', [MAIL], drafts);
  const step = await new ReActPlanner({ router: router(m) })
    .plan({ ...inp, task: { ...inp.task, toolsCalled: ['mail.send'], denied: ['mail.send'] } }, sig);
  assert.equal(step.kind, 'final');
  assert.ok(texts(drafts).every((t) => !t.includes('确认后我就发送')));
  assert.deepEqual(drafts.at(-1), { kind: 'reset', reason: 'check' });
});

test('不传 draft 就不流式；必须调工具的一轮也不流式', async () => {
  const m1 = new StreamingModel([{ chunks: ['你好'] }]);
  await new ReActPlanner({ router: router(m1) }).plan(input('整理一下', [SEARCH]), sig);
  assert.equal(m1.requests[0]?.onText, undefined);

  const drafts: AnswerDraft[] = [];
  const m2 = new StreamingModel([{ chunks: [], toolCalls: [{ id: 'c1', name: 'mail.send', args: { to: 'a@b.com' } }] }]);
  await new ReActPlanner({ router: router(m2) }).plan(input('给 a@b.com 发邮件', [MAIL], drafts), sig);
  assert.equal(m2.requests[0]?.toolChoice, 'required');
  assert.equal(m2.requests[0]?.onText, undefined);
  assert.equal(drafts.length, 0);
});

// ───────── 思考过程 ─────────

test('思考：边想边交出去（kind: thinking），想完的全文记在这一步的 via.reasoning 上', async () => {
  const drafts: AnswerDraft[] = [];
  const m = new StreamingModel([{ thinking: ['用户想要', '本周要点，', '分两条写'], chunks: ['## 本周要点\n- 一、上线了新的检索服务'] }]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input('整理本周要点', [SEARCH], drafts), sig);
  const thinking = drafts.flatMap((d) => (d.kind === 'thinking' ? [d.text] : []));
  assert.deepEqual(thinking, ['用户想要', '用户想要本周要点，', '用户想要本周要点，分两条写']);
  assert.equal(step.via?.reasoning, '用户想要本周要点，分两条写');
  // 思考不是回答：回答草稿里没有它
  assert.ok(texts(drafts).every((t) => !t.includes('分两条写')));
});

test('思考：思考里提到「已发送」不算声称做成了 —— 不撤回、不纠正；必须调工具的一轮也照样交出思考', async () => {
  const drafts: AnswerDraft[] = [];
  const m = new StreamingModel([{ thinking: ['如果我直接说邮件已发送就是在骗人，得先调工具'], chunks: [], toolCalls: [{ id: 'c1', name: 'mail.send', args: { to: 'a@b.com' } }] }]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input('给 a@b.com 发邮件', [MAIL], drafts), sig);
  assert.equal(step.kind, 'tool_call');
  assert.equal(m.requests[0]?.toolChoice, 'required');
  assert.ok(drafts.some((d) => d.kind === 'thinking'));
  assert.ok(!drafts.some((d) => d.kind === 'reset'));
  assert.match(step.via?.reasoning ?? '', /得先调工具/);
});

test('思考：一步里问了模型两次（守卫纠正），两次的思考都留下；太长的截断', async () => {
  const m = new StreamingModel([
    { thinking: ['第一次：直接说发了吧'], chunks: ['好的，我来处理这件事情，请稍等片刻。邮件已发送给 a@b.com'] },
    { thinking: ['第二次：被纠正了，去调工具'], chunks: [], toolCalls: [{ id: 'c1', name: 'mail.send', args: { to: 'a@b.com' } }] },
  ]);
  const step = await new ReActPlanner({ router: router(m) }).plan(input('给 a@b.com 发封信说明天开会', [MAIL], []), sig);
  assert.match(step.via?.reasoning ?? '', /第一次[\s\S]*第二次/);

  const long = new StreamingModel([{ thinking: ['想'.repeat(20_000)], chunks: ['好'] }]);
  const s2 = await new ReActPlanner({ router: router(long) }).plan(input('随便聊聊', [SEARCH], []), sig);
  assert.equal(s2.via?.reasoning?.length, 8_000);
});

test('换模型：上一个模型说到一半出错、换了一个从头来 —— 已显示的半截收回（reset: retry），新的照常显示', async () => {
  const drafts: AnswerDraft[] = [];
  const m: ChatModel = {
    id: 'failover',
    capabilities: { contextWindow: 1000, maxOutputTokens: 100, tools: true, jsonSchema: true, promptCache: false },
    async generate(req) {
      req.onText?.('第一个模型说到一半，后面还有很多很多很多字');
      req.onRetry?.();
      const text = '第二个模型从头来，这是完整的回答内容，足够长';
      req.onText?.(text);
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, modelId: 'b', stopReason: 'stop' };
    },
  };
  await new ReActPlanner({ router: router(m) }).plan(input('整理一下', [SEARCH], drafts), sig);
  const i = drafts.findIndex((d) => d.kind === 'reset' && d.reason === 'retry');
  assert.ok(i > 0, JSON.stringify(drafts));
  assert.ok(drafts.slice(i + 1).some((d) => d.kind === 'text' && d.text.startsWith('第二个模型')));
});

test('用量：一步里问了几次模型就加几次，记在 via.usage 上；数据去向含换过的每一家', async () => {
  const m: ChatModel = {
    id: 'x',
    capabilities: { contextWindow: 1000, maxOutputTokens: 100, tools: true, jsonSchema: true, promptCache: false },
    async generate() {
      return {
        text: '好的，我来处理这件事情，请稍等片刻。邮件已发送给 a@b.com', modelId: 'b', stopReason: 'stop', egress: 'vendor-b', group: 'shared',
        failedAttempts: [{ egress: 'vendor-a', model: 'a', errorCode: 'UPSTREAM' }],
        usage: { inputTokens: 100, outputTokens: 20, costUSD: 0.01, cost: { amount: 0.07, currency: 'CNY' } },
      };
    },
  };
  // 第一次声称已发送 → 守卫纠正，再问一次：两次的用量都要算
  const step = await new ReActPlanner({ router: router(m) }).plan(input('给 a@b.com 发封信说明天开会', [MAIL], []), sig);
  assert.equal(step.via?.usage?.inputTokens, 200);
  assert.equal(step.via?.usage?.outputTokens, 40);
  assert.ok(Math.abs((step.via?.usage?.costUSD ?? 0) - 0.02) < 1e-12);
  assert.ok(Math.abs((step.via?.usage?.cost?.amount ?? 0) - 0.14) < 1e-12);
  assert.deepEqual(step.via?.egress?.split(',').sort(), ['vendor-a', 'vendor-b']);
  assert.equal(step.via?.groups, 'shared', '哪个分组的模型答的（宿主据此说「这次用了兜底的模型」）');
});
