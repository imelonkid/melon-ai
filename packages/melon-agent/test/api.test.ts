import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateResult, ModelEntry } from '@melon-ai/core';
import { ScriptedModel } from '@melon-ai/testkit';
import { consoleLogger, createAgent, defineTool } from '../src/index.js';
import { nodePlatform } from '../src/node.js';
import type { MelonAgent, Task } from '../src/index.js';
import { sqlite } from '../src/sqlite.js';

/**
 * ── 宿主 API 的验收 ──
 *
 * 只用 `@melon-ai/agent` 对外的东西：宿主装这一个包能不能跑、接入代码是不是够薄。
 */

const quiet = { ...nodePlatform(), logger: consoleLogger({ min: 'error', sink: () => {} }) };

const entry = (script: readonly (string | GenerateResult)[]): { entry: ModelEntry; model: ScriptedModel } => {
  const model = new ScriptedModel(script);
  return { model, entry: { model, quality: 5, costUSD: 1, egress: 'test', label: 'test' } };
};

const call = (name: string, args: Record<string, unknown>): GenerateResult => ({
  text: '', modelId: 'scripted', stopReason: 'tool',
  usage: { inputTokens: 10, outputTokens: 5 },
  toolCalls: [{ id: `c-${name}`, name, args }],
});

/** 等到某个任务满足条件（通过 on('task') 看，不轮询存储）。 */
function until(agent: MelonAgent, pred: (t: Task) => boolean, ms = 3000): Promise<Task> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('等待超时')); }, ms);
    const off = agent.on('task', (t) => { if (pred(t)) { clearTimeout(timer); off(); resolve(t); } });
  });
}

test('零配置：只给模型就能跑；默认内存存储；模型看得到任务目标', async () => {
  const { entry: e, model } = entry(['周报已整理好']);
  const agent = await createAgent({ models: [e], platform: quiet });
  try {
    const done = until(agent, (t) => t.state === 'SUCCEEDED');
    const task = await agent.run('汇总本周进展');
    const final = await done;
    assert.equal(final.id, task.id);
    assert.equal(final.outcome?.answer, '周报已整理好');
    assert.ok(model.calls[0]!.messages.some((m) => m.content.includes('汇总本周进展')), '模型得看到目标');
  } finally { await agent.stop(); }
});

test('defineTool + 对外操作要确认；approve 不用传 callId', async () => {
  let sent = 0;
  const mailSend = defineTool({
    id: 'mail.send', description: '发邮件', risk: 'external', scope: ['to'],
    input: { to: 'string', subject: 'string' },
    run: ({ to, subject }: { to: string; subject: string }) => { sent++; return `已将「${subject}」发送至 ${to}`; },
  });
  const { entry: e } = entry([call('mail.send', { to: '产品组', subject: '周报' }), '发好了']);
  const agent = await createAgent({ models: [e], tools: [mailSend], platform: quiet });
  try {
    const waiting = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const task = await agent.run('把周报发给产品组');
    await waiting;
    assert.equal(sent, 0, '默认策略下对外操作必须先确认');
    const done = until(agent, (t) => t.id === task.id && t.state === 'SUCCEEDED');
    await agent.approve(task.id, 'allow');
    assert.equal((await done).outcome?.answer, '发好了');
    assert.equal(sent, 1);
    await assert.rejects(() => agent.approve(task.id, 'allow'), /没有在等确认/);
  } finally { await agent.stop(); }
});

test('始终允许：同一工具同一范围下次不再问；换了收件人照样问；撤销后又问；花钱的不能始终允许', async () => {
  let sent = 0;
  const mailSend = defineTool({
    id: 'mail.send', description: '发邮件', risk: 'external', scope: ['to'], triggers: ['发给'],
    input: { to: 'string', subject: 'string' },
    run: ({ to }: { to: string }) => { sent++; return `已发送至 ${to}`; },
  });
  const buy = defineTool({ id: 'shop.buy', description: '下单', risk: 'spend', input: { item: 'string' }, run: () => '已下单' });
  const { entry: e } = entry([
    call('mail.send', { to: 'a@x.com', subject: '周报' }), '发好了',
    call('mail.send', { to: 'a@x.com', subject: '月报' }), '又发好了',
    call('mail.send', { to: 'b@x.com', subject: '周报' }), '发给 b 了',
    call('shop.buy', { item: '纸' }), '买了',
  ]);
  const agent = await createAgent({ models: [e], tools: [mailSend, buy], platform: quiet });
  // 状态先变成待确认，ApprovalRequested 随后才写进事件日志 —— 等它出现
  const requestOf = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const req = (await agent.tasks.history(id)).map((r) => r.value).filter((ev) => ev.t === 'ApprovalRequested').pop();
      if (req && req.t === 'ApprovalRequested') return req.request;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('没有发出确认请求');
  };
  try {
    const ask1 = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t1 = await agent.run('把周报发给 a@x.com');
    assert.equal((await ask1).id, t1.id);
    assert.equal((await requestOf(t1.id)).canAlways, true, '对外操作可以始终允许');
    const done1 = until(agent, (t) => t.id === t1.id && t.state === 'SUCCEEDED');
    await agent.approve(t1.id, 'always');
    await done1;
    assert.deepEqual((await agent.grants.list()).map((g) => [g.toolId, g.scope]), [['mail.send', 'to=a@x.com']]);

    const done2 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '又发好了');
    await agent.run('把月报发给 a@x.com');
    await done2;
    assert.equal(sent, 2, '同一收件人：命中授权，不再问');

    const ask3 = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t3 = await agent.run('把周报发给 b@x.com');
    await ask3;
    assert.equal(sent, 2, '换了收件人：授权不覆盖，照样问');
    await agent.approve(t3.id, 'deny');

    await agent.grants.revoke('mail.send');
    assert.deepEqual(await agent.grants.list(), []);

    // 审计：用户的审批决定、授权的授予与撤销、数据去向都有记录；审计里不出现收件人
    const rows = [...await agent.stores.audit.query({ limit: 200 })].sort((a, b) => a.seq - b.seq);
    const byUser = rows.filter((r) => r.action === 'approval.decide' && r.actor.kind === 'user');
    assert.deepEqual(byUser.map((r) => [r.dimensions?.['decision'], r.outcome]), [['always', 'allow'], ['deny', 'deny']]);
    assert.deepEqual(rows.filter((r) => r.action === 'policy.change').map((r) => r.dimensions?.['change']), ['grant', 'revoke']);
    const routes = rows.filter((r) => r.action === 'model.route');
    assert.ok(routes.length >= 3, '每次问模型都记一条数据去向');
    assert.equal(routes[0]!.dimensions?.['egress'], 'test');
    // 授权范围可读，放在依据里（维度有长度上限）
    assert.deepEqual(rows.filter((r) => r.action === 'policy.change').map((r) => r.basis?.['scope']), ['to=a@x.com', '*']);

    const ask4 = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t4 = await agent.run('买纸');
    const waiting = await ask4;
    assert.equal((await requestOf(t4.id)).canAlways, false, '花钱的操作不给「始终允许」');
    const done4 = until(agent, (t) => t.id === waiting.id && t.state === 'SUCCEEDED');
    await agent.approve(t4.id, 'always');
    await done4;
    assert.deepEqual(await agent.grants.list(), [], '点了也不记授权');
  } finally { await agent.stop(); }
});

test('when：只在满足条件的任务里把工具给模型', async () => {
  const propose = defineTool({ id: 'task.propose', description: '拟任务', when: (t) => t.trigger.ref?.startsWith('chat:') ?? false, run: () => '' });
  const { entry: e, model } = entry(['好', '好']);
  const agent = await createAgent({ models: [e], tools: [propose], platform: quiet });
  try {
    await agent.run('查一下', {});
    await agent.run('每周发周报', { ref: 'chat:1' });
    await agent.drain();
    // 内置的「读取完整内容」总在，这里只看宿主工具
    const toolNames = model.calls.map((c) => (c.tools ?? []).map((t) => t.name).filter((n) => !n.startsWith('builtin.')));
    assert.deepEqual(toolNames, [[], ['task.propose']]);
  } finally { await agent.stop(); }
});

test('schedules.create({ goal, when })：友好写法、描述、暂停恢复都发 schedule 事件；非法规则带原因报错', async () => {
  const agent = await createAgent({ platform: quiet });
  try {
    const seen: string[] = [];
    agent.on('schedule', (s) => seen.push(`${s.status}`));
    const s = await agent.schedules.create({ goal: '发周报', when: { repeat: 'weekly', days: [5], time: '16:00' } });
    assert.equal(agent.schedules.describe(s), '每周五 16:00');
    assert.equal(s.template.kind, 'automation');
    await agent.schedules.pause(s.id);
    await agent.schedules.resume(s.id);
    await agent.schedules.remove(s.id);
    assert.deepEqual(seen, ['active', 'paused', 'active', 'removed']);
    assert.equal((await agent.schedules.list()).length, 0, 'removed 默认不列出');
    await assert.rejects(() => agent.schedules.create({ goal: 'x', when: { repeat: 'once', at: '2020-01-01 09:00' } }), /已经过了/);
  } finally { await agent.stop(); }
});

test('configure：没有模型时任务明确失败；热替换后立即可用；执行权限可切换', async () => {
  const agent = await createAgent({ platform: quiet });
  try {
    assert.equal(agent.models.ready, false);
    const failed = until(agent, (t) => t.state === 'FAILED');
    await agent.run('随便');
    assert.match((await failed).outcome?.reason ?? '', /没有可用的模型/);

    const docRead = defineTool({ id: 'doc.read', description: '读文档', run: () => '内容' });
    const { entry: e } = entry([call('doc.read', {}), '读完了']);
    await agent.configure({ models: [e], tools: [docRead], policy: 'ask' });
    assert.equal(agent.models.ready, true);
    const asked = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    await agent.run('读一下');
    await asked; // ask 档位下只读工具也要问
  } finally { await agent.stop(); }
});

test('持久化：@melon-ai/agent/sqlite 一行换存储', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melon-api-'));
  const { entry: e } = entry(['好了']);
  const agent = await createAgent({ models: [e], storage: sqlite({ file: join(dir, 'a.db') }), platform: quiet });
  try {
    const done = until(agent, (t) => t.state === 'SUCCEEDED');
    const task = await agent.run('试试');
    await done;
    const history = await agent.tasks.history(task.id);
    assert.equal(history[history.length - 1]?.value.t, 'Settled');
    assert.equal((await agent.tasks.list()).length, 1);
  } finally { await agent.stop(); await agent.stores.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('stop 之后，还在等人的任务的 watch 会收尾 —— 否则进程退不出、或对已关的存储反复轮询', async () => {
  const mailSend = defineTool({ id: 'mail.send', description: '发邮件', risk: 'external', input: { to: 'string' }, run: () => 'ok' });
  const { entry: e } = entry([call('mail.send', { to: 'x' })]);
  const agent = await createAgent({ models: [e], tools: [mailSend], platform: quiet });
  let stopped = false;
  try {
    const waiting = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const task = await agent.run('发');
    await waiting;
    let ended = false;
    const loop = (async () => { for await (const _ of agent.watch(task.id)) { /* 读空 */ } ended = true; })();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ended, false, '任务还在等人，watch 不该自己结束');
    await agent.stop();
    stopped = true;
    await Promise.race([loop, new Promise((r) => setTimeout(r, 500))]);
    assert.equal(ended, true, 'stop 之后 watch 必须收尾');
  } finally {
    // 断言失败也要停 —— 否则引擎的定时器让测试进程永远退不出（实际卡住过半小时）
    if (!stopped) await agent.stop();
  }
});

test('联网技能：@melon-ai/agent/web 按需开启；没配搜索只有读网页，configure 后搜索出现', async () => {
  const { web } = await import('../src/web.js');
  const agent = await createAgent({ skills: [web()], platform: quiet });
  try {
    const webTools = () => agent.tools.list().filter((d) => d.id.startsWith('web.'));
    assert.deepEqual(webTools().map((d) => d.id), ['web.fetch']);
    const backend = { id: 'fake', search: async () => [] };
    await agent.configure({ skills: [web({ search: backend })] });
    assert.deepEqual(webTools().map((d) => d.id).sort(), ['web.fetch', 'web.search']);
    assert.ok(webTools().every((d) => d.untrustedOutput), '联网工具都得声明输出不可信');
    assert.ok(agent.tools.list().some((d) => d.id === 'builtin.artifact_read'), '换技能来源时内置工具保留');
  } finally { await agent.stop(); }
});

test('入口一次拿全：各家模型工厂（含通用 compatible）都从 @melon-ai/agent 导出', async () => {
  const api = await import('../src/index.js');
  for (const name of ['deepseek', 'qwen', 'openai', 'kimi', 'compatible']) {
    assert.equal(typeof (api as Record<string, unknown>)[name], 'function', name);
  }
  const z = api.compatible({ label: '智谱', baseURL: 'https://x.test/v4', model: 'glm-4', apiKey: 'k', egress: 'zhipu' });
  assert.equal(z.egress, 'zhipu');
});

test('流式：宿主用 on(\'draft\') 收到正在生成的回答（带 taskId、全文），最终回答以任务结果为准', async () => {
  const answer = '本周完成了三件事：上线了新的检索服务，修好了登录超时，整理了接入文档。';
  const { entry: e } = entry([answer]);
  const agent = await createAgent({ models: [e], platform: quiet });
  try {
    const drafts: { taskId: string; kind: string; text?: string }[] = [];
    agent.on('draft', (d) => drafts.push({ taskId: d.taskId, kind: d.kind, ...(d.kind === 'text' ? { text: d.text } : {}) }));
    const done = until(agent, (t) => t.state === 'SUCCEEDED');
    const task = await agent.run('汇总本周进展');
    const final = await done;
    assert.ok(drafts.length >= 2, '应当分好几段到达');
    assert.ok(drafts.every((d) => d.taskId === task.id && d.kind === 'text'));
    // 草稿末尾留了几个字（守卫先看过才显示），所以只是最终回答的前缀；最终回答以任务结果为准
    assert.equal(final.outcome?.answer, answer);
    assert.ok(drafts.every((d) => answer.startsWith(d.text ?? '')));
  } finally { await agent.stop(); }
});

test('思考：记在这一步的事件上，宿主事后看得到；但不回灌进下一次问模型的上下文', async () => {
  const lookup = defineTool({
    id: 'kb.lookup', description: '查资料', risk: 'read', input: { q: 'string' },
    run: ({ q }: { q: string }) => `资料：${q} 的结果`,
  });
  const { entry: e, model } = entry([
    { ...call('kb.lookup', { q: '周报' }), reasoning: '先查资料，暗号XYZ' },
    { text: '查好了，周报在这。', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, reasoning: '整理一下' },
  ]);
  const agent = await createAgent({ models: [e], tools: [lookup], platform: quiet });
  try {
    const done = until(agent, (t) => t.state === 'SUCCEEDED');
    const task = await agent.run('查一下周报资料');
    await done;
    const steps = (await agent.tasks.history(task.id)).map((r) => r.value).filter((v) => v.t === 'PlanProduced');
    assert.deepEqual(steps.map((v) => (v.t === 'PlanProduced' ? v.step.via?.reasoning : null)), ['先查资料，暗号XYZ', '整理一下']);
    assert.ok(!model.calls[1]!.messages.some((m) => m.content.includes('XYZ')), '思考不该进下一次的上下文');
  } finally { await agent.stop(); }
});

test('计量：任务的用量是真实的（含输出与费用），费用预算按真实花费生效；账本与汇总看得到每次调用', async () => {
  const { model } = entry([
    call('kb.lookup', { q: '一' }), call('kb.lookup', { q: '二' }), call('kb.lookup', { q: '三' }), '答完了',
  ]);
  const lookup = defineTool({ id: 'kb.lookup', description: '查资料', risk: 'read', input: { q: 'string' }, run: ({ q }: { q: string }) => `资料 ${q}` });
  // 每次 10 输入 + 5 输出；每百万 token 10 万美元 → 每次 1.5 美元
  const priced = { model, quality: 5, costUSD: 1, egress: 'test', label: 'test', price: { input: 100_000, output: 100_000, currency: 'USD' as const } };
  const agent = await createAgent({ models: [priced], tools: [lookup], platform: quiet });
  try {
    const done = until(agent, (t) => ['SUCCEEDED', 'FAILED'].includes(t.state));
    const task = await agent.run('查三次资料', { budget: { maxCostUSD: 2 } });
    const final = await done;
    // 第二次问完累计 3 美元，超了 2 美元的预算 —— 没有真实费用时这个预算永远不触发
    assert.equal(final.state, 'FAILED');
    assert.ok(final.usage.costUSD >= 2, `costUSD=${final.usage.costUSD}`);
    assert.ok(final.usage.tokens > 20, '输出 token 也要算进去');
    const rows = await agent.usage.list({ from: 0, to: Date.now() + 1000 });
    assert.ok(rows.length >= 2 && rows.every((r) => r.taskId === task.id && r.priced && r.purpose === 'plan'));
    const s = await agent.usage.summary({ from: Date.now() - 60_000, to: Date.now() + 1000, currency: 'USD' });
    assert.equal(s.calls, rows.length);
    assert.ok(Math.abs(s.cost - 1.5 * rows.length) < 1e-9);
  } finally { await agent.stop(); }
});

test('路由：auto 策略按宿主规则挑模型（任务类别、最低档、固定），explain 说明为什么', async () => {
  const cheap = entry(['便宜模型答的']);
  const strong = entry(['强模型答的']);
  const models = [
    { ...cheap.entry, model: Object.assign(cheap.model, { id: 'cheap' }), egress: 'a', tier: 'standard' as const, price: { input: 1, output: 1, currency: 'CNY' as const } },
    { ...strong.entry, model: Object.assign(strong.model, { id: 'strong' }), egress: 'b', tier: 'strong' as const, price: { input: 9, output: 9, currency: 'CNY' as const } },
  ];
  const agent = await createAgent({
    models, strategy: 'auto', platform: quiet,
    // 定时任务要强档；其余标准档就行
    routing: (meta) => (meta?.trigger === 'schedule' ? { taskClass: 'schedule', minTier: 'strong' } : { taskClass: 'chat', minTier: 'standard' }),
  });
  try {
    const done = until(agent, (t) => t.state === 'SUCCEEDED');
    await agent.run('随便问问');
    assert.equal((await done).outcome?.answer, '便宜模型答的');
    assert.equal(agent.models.explain({ taskClass: 'chat', minTier: 'standard' }).ranked[0]!.key, 'a/cheap');
    assert.equal(agent.models.explain({ taskClass: 'schedule', minTier: 'strong' }).ranked[0]!.key, 'b/strong');
    // 换规则：固定用强模型
    await agent.configure({ routing: () => ({ taskClass: 'chat', minTier: 'standard', pin: 'b/strong' }) });
    const done2 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '强模型答的');
    await agent.run('再问一次');
    assert.ok(await done2);
  } finally { await agent.stop(); }
});

test('模型目录：providers 跟随厂商最新可用的模型（/models ∩ 有价格或内置档次），拉完发 models 事件；定时任务按 triggerRef 单独绑定模型', async () => {
  const replies: Record<string, string> = {};
  const mk = (id?: string): ModelEntry => {
    const mid = id ?? 'flash';
    const model = new ScriptedModel(Array.from({ length: 5 }, () => `${mid} 答的`));
    Object.assign(model, { id: mid, listModels: async () => ['flash', 'pro', 'embed'] });
    replies[mid] = `${mid} 答的`;
    const builtin: Record<string, ModelEntry['tier']> = { flash: 'standard', pro: 'strong' };
    return {
      model, quality: 1, costUSD: 1, egress: 'ds', label: 'DeepSeek',
      ...(builtin[mid] ? { tier: builtin[mid] } : {}),
      ...(mid === 'pro' ? { price: { input: 9, output: 9, currency: 'CNY' as const } } : mid === 'flash' ? { price: { input: 1, output: 1, currency: 'CNY' as const } } : {}),
    };
  };
  let bound: string | undefined;
  const agent = await createAgent({
    strategy: 'auto', platform: quiet, start: false,
    providers: [{ vendor: 'ds', label: 'DeepSeek', make: mk, fingerprint: 'k1' }],
    // 单个定时任务绑定了模型就用它，其余按类别
    routing: (meta) => (meta?.trigger === 'schedule'
      ? { taskClass: 'schedule', minTier: 'standard', ...(bound && meta.triggerRef === bound ? { pin: 'ds/pro' } : {}) }
      : { taskClass: 'chat', minTier: 'standard' }),
  });
  try {
    // 启动前：还没拉过列表，先用默认模型
    assert.deepEqual(agent.models.entries.map((e) => e.model.id), ['flash']);
    const changed = new Promise((r) => { const off = agent.on('models', (c) => { off(); r(c); }); });
    await agent.start();
    await changed;
    assert.deepEqual(agent.models.entries.map((e) => e.model.id).sort(), ['flash', 'pro']);
    const cat = agent.models.catalog()[0]!;
    assert.deepEqual(cat.others, ['embed']);

    const s = await agent.schedules.create({ title: '周报', template: { agentId: 'default' as never, kind: 'automation', goal: '写周报' }, rule: { kind: 'once', at: Date.now() + 5 } });
    bound = s.id;
    const done = until(agent, (t) => t.state === 'SUCCEEDED' && t.trigger.type === 'schedule');
    await new Promise((r) => setTimeout(r, 20));
    await agent.schedules.tick();
    const dt = await done;
    assert.equal(dt.outcome?.answer, 'pro 答的', '这个定时任务绑定了 pro');
    const chat = until(agent, (t) => t.state === 'SUCCEEDED' && t.trigger.type === 'manual');
    await agent.run('随便问问');
    assert.equal((await chat).outcome?.answer, 'flash 答的', '对话按推荐用便宜的');
  } finally { await agent.stop(); }
});
