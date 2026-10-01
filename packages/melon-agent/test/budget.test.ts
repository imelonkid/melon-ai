import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextBundle, GenerateResult, Message } from '@melon-ai/core';
import { HeuristicTokenizer } from '@melon-ai/llm';
import { ScriptedModel } from '@melon-ai/testkit';
import { consoleLogger, createAgent, defineTool } from '../src/index.js';
import { nodePlatform } from '../src/node.js';
import { fitContext } from '../src/budget.js';

const tk = new HeuristicTokenizer();
const bundle = (messages: Message[]): ContextBundle => ({ messages, tools: [], slots: [], totalTokens: 0, window: 200_000, watermark: 0.7 });
const big = (tag: string, n = 1500) => `${tag}：${'数据'.repeat(n)}`;

/** 宿主说明 + 6 轮之前的对话 + 目标 + 10 步（每步一次调用、一段长结果）。 */
function longContext(): Message[] {
  const history: Message[] = [];
  for (let i = 1; i <= 6; i++) history.push({ role: 'user', content: `第${i}轮问题 ${'问'.repeat(400)}`, part: 'history' }, { role: 'assistant', content: `第${i}轮回答 ${'答'.repeat(800)}`, part: 'history' });
  const steps: Message[] = [];
  for (let i = 1; i <= 10; i++) steps.push({ role: 'user', from: 'tool', part: 'step', content: `【调用工具】读文件 ${i}` }, { role: 'user', from: 'tool', part: 'result', content: big(`结果${i}`) });
  return [
    { role: 'user', from: 'host', content: '宿主的说明' },
    ...history,
    { role: 'user', content: '任务目标：整理九月的报表' },
    { role: 'user', from: 'host', content: '（现在是 2026-10-02。）' },
    ...steps,
  ];
}

test('上下文预算：没超不动；超了先截短旧的工具结果（最近的原样），说明、目标、时间不动', async () => {
  const small = [{ role: 'user' as const, content: '你好' }];
  const same = await fitContext(bundle(small), { budget: 1000, tokenizer: tk });
  assert.deepEqual(same.report.actions, []);
  const ms = longContext();
  const r = await fitContext(bundle(ms), { budget: 22_000, tokenizer: tk });
  assert.deepEqual(r.report.actions, ['trim']);
  assert.ok(r.report.after <= 22_000 && r.report.before > 22_000, `${r.report.before} → ${r.report.after}`);
  const out = r.bundle.messages;
  assert.ok(out.find((m) => m.content.startsWith('结果1'))!.content.includes('较早的结果已截短'));
  assert.equal(out.find((m) => m.content.startsWith('结果10'))!.content, big('结果10'), '最近的结果原样');
  for (const keep of ['宿主的说明', '任务目标：整理九月的报表', '（现在是 2026-10-02。）']) assert.ok(out.some((m) => m.content === keep));
});

test('上下文预算：还超就摘要之前的对话（最后两轮原样），再摘要较早的步骤（仍是工具数据）；摘要失败退回到丢弃并标出来', async () => {
  const calls: string[] = [];
  const summarize = async (_text: string, kind: 'history' | 'steps') => { calls.push(kind); return kind === 'history' ? '用户要九月报表，偏好表格' : '读了 1–4 号文件，合计 1280'; };
  const r = await fitContext(bundle(longContext()), { budget: 13_000, tokenizer: tk, summarize });
  assert.deepEqual(r.report.actions, ['trim', 'history', 'steps']);
  assert.ok(r.report.after <= 13_000, `压缩后 ${r.report.after}`);
  const out = r.bundle.messages;
  assert.ok(out.some((m) => m.content === '（之前对话的摘要）\n用户要九月报表，偏好表格' && m.part === 'history'));
  assert.ok(out.some((m) => m.content.startsWith('第6轮回答')) && out.some((m) => m.content.startsWith('第5轮问题')), '最后两轮原样');
  assert.ok(!out.some((m) => m.content.startsWith('第1轮问题')));
  const steps = out.find((m) => m.content.startsWith('【之前步骤的摘要】'))!;
  assert.equal(steps.from, 'tool', '工具结果的摘要仍是工具数据');
  assert.ok(out.some((m) => m.content === big('结果10')));

  const failing = await fitContext(bundle(longContext()), { budget: 13_000, tokenizer: tk, summarize: async () => { throw new Error('模型出错'); } });
  assert.deepEqual(failing.report.actions, ['trim', 'history-drop', 'steps-drop']);
  assert.ok(failing.bundle.messages.some((m) => m.content === '（更早的 4 轮对话已省略）'));
  assert.ok(failing.bundle.messages.some((m) => /更早的 \d+ 条步骤已省略/.test(m.content)));

  // 最后的手段：最近几步本身就超了，按比例截短，但说明和目标照样在
  const tiny = await fitContext(bundle(longContext()), { budget: 2500, tokenizer: tk, summarize });
  assert.ok(tiny.report.actions.includes('squeeze'));
  assert.ok(tiny.bundle.messages.some((m) => m.content === '任务目标：整理九月的报表'));
});

const quiet = { ...nodePlatform(), logger: consoleLogger({ min: 'error', sink: () => {} }) };
const call = (name: string, args: Record<string, unknown>): GenerateResult => ({
  text: '', modelId: 'scripted', stopReason: 'tool', usage: { inputTokens: 10, outputTokens: 5 },
  toolCalls: [{ id: `c-${Math.random()}`, name, args }],
});

test('createAgent：长任务的上下文控制在预算内 —— 摘要走 compact 路由、记账，同一段内容不重复摘要', async () => {
  const read = defineTool({ id: 'doc.page', description: '读文档的一页', input: { n: 'integer' }, run: ({ n }: { n: number }) => big(`第${n}页`, 2500) });
  // 规划 8 步读文档，第 9 步作答；摘要请求单独回要点
  const model = new ScriptedModel([]);
  const plan = Array.from({ length: 8 }, (_, i) => call('doc.page', { n: i + 1 }));
  let step = 0;
  // 按请求内容决定回什么：摘要请求回要点，其余按计划走
  model.generate = async (req) => {
    (model.calls as unknown as unknown[]).push(req);
    if (req.messages[0]?.role === 'system' && req.messages[0].content.includes('压缩它的工作记录')) {
      return { text: '读过前几页，每页都是数据', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 } };
    }
    const r = plan[step++] ?? { text: '读完了', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
    return r as GenerateResult;
  };
  const agent = await createAgent({
    models: [{ model, quality: 1, costUSD: 1, egress: 'test', label: 'test' }],
    tools: [read], platform: quiet, contextBudget: 8000,
  });
  try {
    const done = new Promise<void>((ok) => { const off = agent.on('task', (t) => { if (t.state === 'SUCCEEDED') { off(); ok(); } }); });
    await agent.run('把文档读一遍');
    await done;
    const reqs = model.calls as unknown as { messages: Message[]; meta?: { purpose: string } }[];
    const planning = reqs.filter((r) => r.meta?.purpose !== 'compact');
    const summaries = reqs.filter((r) => r.meta?.purpose === 'compact');
    assert.ok(summaries.length >= 1, '超了预算会摘要');
    for (const r of planning) {
      const ctx = r.messages.filter((m) => m.role !== 'system');
      assert.ok(tk.countMessages(ctx) <= 8000 + 200, `发给模型的上下文 ${tk.countMessages(ctx)} token`);
    }
    // 同样的旧内容不重复摘要：摘要次数远少于规划次数
    assert.ok(summaries.length < planning.length, `摘要 ${summaries.length} 次 / 规划 ${planning.length} 次`);
    const ledger = await agent.usage.list({ from: 0, to: Date.now() + 1 });
    assert.ok(ledger.some((x) => x.purpose === 'compact'), '摘要的调用记账');
  } finally { await agent.stop(); }
});
