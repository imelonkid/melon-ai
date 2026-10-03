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
import { FILES_GRANT_KEY, files, folderScope } from '../src/files.js';

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

test('被沙箱拦下：工具错误里的拦截信息（联网 / 读 / 写）随事件落盘，宿主事后看得到、能给放行入口', async () => {
  const { ToolError } = await import('@melon-ai/core');
  const { entry: e } = entry([call('script.run', { name: 'a' }), '没能运行']);
  const agent = await createAgent({
    models: [e], platform: quiet,
    tools: [defineTool({
      id: 'script.run', description: '运行脚本', input: { name: 'string' }, risk: 'write',
      run: async () => { throw new ToolError('DENIED', '脚本想联网，被沙箱拦下了', { retriable: false, sandbox: { kind: 'network' } }); },
    })],
  });
  try {
    const done = until(agent, (t) => t.state === 'SUCCEEDED' || t.state === 'FAILED');
    const t = await agent.run('运行脚本');
    await done;
    const fin = (await agent.tasks.history(t.id)).map((r) => r.value).find((v) => v.t === 'ToolCallFinished') as { meta: { errorCode?: string; sandbox?: unknown } };
    assert.equal(fin.meta.errorCode, 'DENIED');
    assert.deepEqual(fin.meta.sandbox, { kind: 'network' });
  } finally { await agent.stop(); }
});

test('本地文件：第一次先问；「始终允许」按文件夹 —— 子文件夹、另外两个工具都放行，别的文件夹照样问；路径写错不打扰用户；宿主能替用户预先允许', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'jolly-files-'));
  const dl = join(root, 'Downloads');
  const docs = join(root, 'Documents');
  mkdirSync(join(dl, '报表'), { recursive: true });
  mkdirSync(docs);
  writeFileSync(join(dl, '报表', 'a.txt'), '九月费用 1280');
  writeFileSync(join(docs, 'b.txt'), 'b');
  const { entry: e } = entry([
    call('files.list', { folder: dl }), '下载目录里有一个报表文件夹',
    call('files.read', { folder: join(dl, '报表'), file: 'a.txt' }), '九月费用 1280',
    call('files.list', { folder: join(root, 'Download') }), '没有这个文件夹，是不是 Downloads？',
    call('files.list', { folder: docs }), '文档里有 b.txt',
    call('files.list', { folder: docs }), '文档里还是 b.txt',
  ]);
  const agent = await createAgent({ models: [e], skills: [files()], platform: quiet });
  const states = (id: string) => agent.tasks.history(id).then((rows) => rows.map((r) => r.value.t));
  try {
    const ask = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t1 = await agent.run('看下下载文件夹里有什么文件');
    await ask;
    const done1 = until(agent, (t) => t.id === t1.id && t.state === 'SUCCEEDED');
    await agent.approve(t1.id, 'always');
    await done1;
    assert.deepEqual((await agent.grants.list()).map((g) => [g.toolId, g.scope]), [[FILES_GRANT_KEY, folderScope(dl)]]);

    // 子文件夹 + 另一个工具：命中同一份授权，不再问
    const done2 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '九月费用 1280');
    const t2 = await agent.run('读一下报表文件夹里的文件 a.txt');
    await done2;
    assert.ok(!(await states(t2.id)).includes('ApprovalRequested'), '允许过的文件夹里读文件不再问');

    // 写错的文件夹：问之前就退回给模型（带上近似的名字），用户不用批准一个注定失败的调用
    const done3 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer?.startsWith('没有这个文件夹') === true);
    const t3 = await agent.run('看下 Download 文件夹');
    await done3;
    const rows3 = (await agent.tasks.history(t3.id)).map((r) => r.value);
    assert.ok(!rows3.some((v) => v.t === 'ApprovalRequested'));
    assert.match(JSON.stringify(rows3.find((v) => v.t === 'Observed')), /可能是 .*Downloads/);

    // 别的文件夹：照样问
    const ask4 = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t4 = await agent.run('看下文档文件夹里的文件');
    await ask4;
    const done4 = until(agent, (t) => t.id === t4.id && t.state === 'SUCCEEDED');
    await agent.approve(t4.id, 'allow');
    await done4;

    // 宿主替用户预先允许（「本地文件」里添加文件夹）
    await agent.grants.add(FILES_GRANT_KEY, folderScope(docs));
    const done5 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '文档里还是 b.txt');
    const t5 = await agent.run('再看下文档文件夹里的文件');
    await done5;
    assert.ok(!(await states(t5.id)).includes('ApprovalRequested'));
  } finally { await agent.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('没执行的调用也要回喂给模型：参数不合法、问之前的检查没过、用户拒绝 —— 下一次问模型时看得到原因', async () => {
  const tool = defineTool({
    id: 'crm.note', description: '记客户跟进', risk: 'external', triggers: [],
    input: { customer: 'string' },
    precheck: async (a: { customer: string }) => (a.customer === '不存在的客户' ? { message: '没有这个客户', hint: '可能是 张三：用它再试一次' } : null),
    run: () => '记好了',
  });
  const { entry: e, model } = entry([
    call('crm.note', { customer: 1 }), call('crm.note', { customer: '不存在的客户' }), call('crm.note', { customer: '张三' }), '没记',
  ]);
  const agent = await createAgent({ models: [e], tools: [tool], platform: quiet });
  try {
    const ask = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t = await agent.run('给客户记一笔跟进');
    await ask;
    const done = until(agent, (x) => x.id === t.id && x.state === 'SUCCEEDED');
    await agent.approve(t.id, 'deny');
    await done;
    const seen = (i: number) => model.calls[i]!.messages.map((m) => m.content).join('\n');
    assert.match(seen(1), /参数不合法/, '参数不合法：第二次问模型时看得到');
    assert.match(seen(2), /没有这个客户。可能是 张三/, '检查没过：原因和提示都看得到');
    assert.match(seen(3), /用户拒绝了这次操作/, '用户拒绝：看得到');
  } finally { await agent.stop(); }
});

test('附件：这一轮的上下文里有附件的开头和句柄，能读全文；任务算读过不可信内容；追问时沿用的附件还读得到。生成的文件随事件落盘', async () => {
  const { outputs } = await import('../src/files.js');
  const out = mkdtempSync(join(tmpdir(), 'jolly-out-'));
  const long = `部门,费用\n${'产品部,1280\n'.repeat(400)}最后一行,9999`;
  const { entry: e, model } = entry([
    call('builtin.artifact_read', { ref: 'REF', offset: 3000 }), '最后一行是 9999',
    call('builtin.artifact_read', { ref: 'REF' }), '第一行是表头',
    call('output.write', { name: '汇总.csv', content: '部门,费用' }), '生成好了',
  ]);
  // 句柄要等附件存进去才知道：调用时把 REF 换成真的
  const gen = model.generate.bind(model);
  let ref = '';
  model.generate = async (req) => {
    const r = await gen(req);
    return r.toolCalls ? { ...r, toolCalls: r.toolCalls.map((c) => (c.args && (c.args as { ref?: string }).ref === 'REF' ? { ...c, args: { ...(c.args as object), ref } } : c)) } : r;
  };
  const agent = await createAgent({ models: [e], skills: [outputs({ dir: out })], platform: quiet });
  try {
    const done1 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '最后一行是 9999');
    const t1 = await agent.run('看下这个表最后一行', { attachments: [{ name: '费用.csv', size: long.length, note: '文本', text: long }] });
    ref = t1.attachments![0]!.textRef;
    await done1;
    const first = model.calls[0]!.messages.map((m) => m.content).join('\n');
    assert.match(first, /【附件】费用\.csv（文本，共 \d+ 字；完整内容句柄：art-/);
    assert.match(first, /后面还有 \d+ 字/);
    assert.ok((await agent.tasks.get(t1.id))!.tainted, '附件里可能藏指令：读过的任务之后对外操作要确认');
    const read1 = (await agent.tasks.history(t1.id)).map((r) => r.value).find((v) => v.t === 'Observed');
    assert.match(JSON.stringify(read1), /9999/, '能读到附件的全文');

    // 追问：沿用上一轮的附件，句柄还读得到
    const done2 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '第一行是表头');
    const t2 = await agent.run('那第一行呢', { attachments: t1.attachments ?? [] });
    await done2;
    const seen = model.calls[2]!.messages.map((m) => m.content).join('\n');
    assert.match(seen, /之前给过的，需要时再读/);
    assert.match(JSON.stringify((await agent.tasks.history(t2.id)).map((r) => r.value).find((v) => v.t === 'Observed')), /部门,费用/);
    assert.equal((await agent.tasks.get(t2.id))!.tainted, false, '只是沿用、这一轮没给新文件：不算');

    // 生成文件：事件里带上文件，宿主据此显示文件卡片
    const done3 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '生成好了');
    const t3 = await agent.run('生成文件：把汇总存成表格');
    await done3;
    const fin = (await agent.tasks.history(t3.id)).map((r) => r.value).find((v) => v.t === 'ToolCallFinished') as unknown as { meta: { files?: { name: string }[] } };
    assert.deepEqual(fin.meta.files?.map((f) => f.name), ['汇总.csv']);
  } finally { await agent.stop(); rmSync(out, { recursive: true, force: true }); }
});

test('整理文件：允许查看不等于允许整理（单独问、单独「始终允许」）；改动随事件落盘，宿主据此撤销；读过文件名的任务整理照样问', async () => {
  const { mkdirSync, writeFileSync, existsSync, realpathSync } = await import('node:fs');
  const { FILES_ORGANIZE_GRANT_KEY, undoState, undoChanges } = await import('../src/files.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jolly-org-')));
  const dl = join(root, 'Downloads');
  mkdirSync(dl);
  writeFileSync(join(dl, 'a.pdf'), 'a');
  writeFileSync(join(dl, 'b.pdf'), 'b');
  const { entry: e } = entry([
    call('files.move', { folder: dl, items: [{ from: 'a.pdf', to: 'PDF/' }] }), '移好了',
    call('files.move', { folder: dl, items: [{ from: 'b.pdf', to: 'PDF/' }] }), '又移好了',
    call('files.list', { folder: dl }), call('files.move', { folder: dl, items: [{ from: 'PDF/a.pdf', to: 'a.pdf' }] }), '移回来了',
  ]);
  const agent = await createAgent({ models: [e], skills: [files({ organize: true, organizeRoots: [root] })], platform: quiet });
  try {
    await agent.grants.add(FILES_GRANT_KEY, folderScope(dl));
    const ask = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t1 = await agent.run('把 a.pdf 移到 PDF 文件夹');
    await ask;
    const done1 = until(agent, (t) => t.id === t1.id && t.state === 'SUCCEEDED');
    await agent.approve(t1.id, 'always');
    await done1;
    assert.ok(existsSync(join(dl, 'PDF', 'a.pdf')));
    assert.ok((await agent.grants.list()).some((g) => g.toolId === FILES_ORGANIZE_GRANT_KEY && g.scope === folderScope(dl)));
    const fin = (await agent.tasks.history(t1.id)).map((r) => r.value).find((v) => v.t === 'ToolCallFinished') as unknown as { meta: { changes?: Parameters<typeof undoState>[0] } };
    assert.deepEqual(fin.meta.changes?.map((c) => c.op), ['mkdir', 'move']);

    // 允许过整理这个文件夹：不再问
    const done2 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '又移好了');
    const t2 = await agent.run('把 b.pdf 也移过去');
    await done2;
    assert.ok(!(await agent.tasks.history(t2.id)).some((r) => r.value.t === 'ApprovalRequested'));

    // 先看过文件夹（文件名是外部内容）：整理照样问，「始终允许」也放不过
    const ask3 = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t3 = await agent.run('看看下载文件夹，把 a.pdf 拿出来');
    await ask3;
    assert.equal((await agent.tasks.get(t3.id))!.pendingCall?.toolId, 'files.move');
    const done3 = until(agent, (t) => t.id === t3.id && t.state === 'SUCCEEDED');
    await agent.approve(t3.id, 'allow');
    await done3;

    // 撤销第一次：a.pdf 已经被第三次挪走了 → 冲突，不动
    assert.equal(undoState(fin.meta.changes!).state, 'conflict');
    assert.equal((await undoChanges(fin.meta.changes!)).undone, 0);
    assert.ok(existsSync(join(dl, 'a.pdf')));
  } finally { await agent.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('MCP：服务器的工具第一次先问、可以按工具始终允许；标了有破坏性的每次都问、不能始终允许；调用过的任务带污点', async () => {
  const { mcp } = await import('../src/mcp.js');
  const { fileURLToPath } = await import('node:url');
  const fixture = fileURLToPath(new URL('../../melon-skills/test/mcp/fixture-server.mjs', import.meta.url));
  const server = mcp({ name: 'fixture', transport: { kind: 'stdio', command: process.execPath, args: [fixture] }, sandbox: false });
  await server.ready();
  const { entry: e } = entry([
    call('fixture.getweather', { city: '杭州' }), '杭州晴',
    call('fixture.getweather', { city: '上海' }), '上海也晴',
    call('fixture.delete_repo', { repo: 'a' }), '删了',
  ]);
  const agent = await createAgent({ models: [e], skills: [server], platform: quiet });
  try {
    const ask1 = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t1 = await agent.run('杭州天气');
    await ask1;
    const done1 = until(agent, (t) => t.id === t1.id && t.state === 'SUCCEEDED');
    await agent.approve(t1.id, 'always');
    await done1;
    assert.equal((await agent.tasks.get(t1.id))!.tainted, true, 'MCP 的输出不可信');

    const done2 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === '上海也晴');
    const t2 = await agent.run('上海天气');
    await done2;
    assert.ok(!(await agent.tasks.history(t2.id)).some((r) => r.value.t === 'ApprovalRequested'), '始终允许过这个工具：不再问');

    const ask3 = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
    const t3 = await agent.run('删掉仓库 a');
    await ask3;
    const adm = (await agent.tasks.history(t3.id)).map((r) => r.value).find((v) => v.t === 'AdmissionResolved') as unknown as { decision: string; risk: string };
    assert.deepEqual([adm.decision, adm.risk], ['ask', 'irreversible'], '有破坏性：按不可撤销，每次都问、不能始终允许');
    const done3 = until(agent, (t) => t.id === t3.id && t.state === 'SUCCEEDED');
    await agent.approve(t3.id, 'allow');
    await done3;
  } finally { await agent.stop(); await server.close(); }
});

test('取消：模型正在想、工具正在跑时都能停 —— 任务立刻变成已取消，进行中的模型请求和工具被中断，迟到的结果丢掉，不再问模型', async () => {
  // 一个慢模型：第一次调用调慢工具；之后的调用一直等，直到被中断
  const model = new ScriptedModel([]);
  let modelAborted = 0;
  let calls = 0;
  model.generate = async (req) => {
    calls += 1;
    if (calls === 1) return call('slow.work', {});
    return new Promise((ok, fail) => {
      const t = setTimeout(() => ok({ text: '想完了', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }), 3000);
      req.signal?.addEventListener('abort', () => { clearTimeout(t); modelAborted += 1; fail(new Error('aborted')); }, { once: true });
    });
  };
  let toolAborted = false;
  let toolStarted: () => void = () => {};
  const started = new Promise<void>((r) => { toolStarted = r; });
  const slow = defineTool({
    id: 'slow.work', description: '做一件很慢的事', triggers: [],
    run: (_a, cx) => new Promise((ok, fail) => {
      toolStarted();
      const t = setTimeout(() => ok('做完了'), 3000);
      cx.signal.addEventListener('abort', () => { clearTimeout(t); toolAborted = true; fail(new Error('aborted')); }, { once: true });
    }),
  });
  const agent = await createAgent({ models: [{ model, quality: 1, costUSD: 1, egress: 'test', label: 'test' }], tools: [slow], platform: quiet });
  try {
    // ① 工具正在跑时取消
    const t1 = await agent.run('做那件很慢的事');
    await started;
    const t0 = Date.now();
    await agent.cancel(t1.id);
    const after1 = await agent.tasks.get(t1.id);
    assert.equal(after1!.state, 'CANCELLED');
    assert.ok(Date.now() - t0 < 1000, '立刻停');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(toolAborted, true, '正在跑的工具收到中断');
    const ev1 = (await agent.tasks.history(t1.id)).map((r) => r.value.t);
    assert.equal(ev1[ev1.length - 1], 'Cancelled', `取消之后不再有事件：${ev1.join(',')}`);

    // ② 模型正在想时取消
    const callsBefore = calls;
    const thinking = until(agent, (t) => t.state === 'PLANNING' || t.state === 'RUNNING' as never, 2000).catch(() => null);
    const t2 = await agent.run('再想想');
    await thinking;
    for (let i = 0; i < 40 && calls === callsBefore; i++) await new Promise((r) => setTimeout(r, 25));
    await agent.cancel(t2.id, '用户停止');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(modelAborted, 1, '进行中的模型请求被中断（不再计费）');
    const t2Done = await agent.tasks.get(t2.id);
    assert.equal(t2Done!.state, 'CANCELLED');
    assert.equal(t2Done!.outcome?.reason, '用户停止');
    assert.equal(calls, callsBefore + 1, '取消后不再问模型');

    // 已经结束的任务再取消：不报错、不改变结果
    await agent.cancel(t2.id);
    assert.equal((await agent.tasks.get(t2.id))!.state, 'CANCELLED');
  } finally { await agent.stop(); }
});

test('取消：回答写到一半停下 —— 已经显示出来的留在结果里（partial），不当成回答', async () => {
  const model = new ScriptedModel([]);
  model.generate = async (req) => new Promise((ok, fail) => {
    req.onText?.('好的，我想一想。今天可以吃点清淡的，比如一碗面');
    const t = setTimeout(() => ok({ text: '好的。', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }), 3000);
    req.signal?.addEventListener('abort', () => { clearTimeout(t); fail(new Error('aborted')); }, { once: true });
  });
  const agent = await createAgent({ models: [{ model, quality: 1, costUSD: 1, egress: 'test', label: 'test' }], platform: quiet });
  try {
    let shown = '';
    agent.on('draft', (d) => { if (d.kind === 'text') shown = d.text; });
    const t = await agent.run('今天吃什么');
    for (let i = 0; i < 40 && !shown; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(shown.startsWith('好的，我想一想'), `草稿：${shown}`);
    await agent.cancel(t.id, '你停止了');
    const done = (await agent.tasks.get(t.id))!;
    assert.deepEqual(done.outcome, { status: 'CANCELLED', reason: '你停止了', partial: shown }, '留下的是用户已经看到的那一截');
    assert.equal(done.outcome?.answer, undefined, '没写完、没核对：不是回答');
  } finally { await agent.stop(); }
});

test('看图：图片附件发给能看图的模型（带上内容）；只启用了看不了图的模型时直接说明，不让它瞎猜；追问时沿用最近的图，最多 4 张', async () => {
  const seen: { model: string; images: number; data: boolean }[] = [];
  const mk = (id: string, vision: boolean) => {
    const m = new ScriptedModel([]);
    (m as { id: string }).id = id;
    (m as unknown as { capabilities: object }).capabilities = { ...m.capabilities, vision };
    m.generate = async (req) => {
      const imgs = req.messages.flatMap((x) => x.images ?? []);
      seen.push({ model: id, images: imgs.length, data: imgs.every((i) => typeof i.data === 'string' && i.data.length > 0) });
      return { text: `${id} 看完了`, modelId: id, stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    return m;
  };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  // 看不了图的排在前面（更便宜、质量更高）—— 带图时也不能选它
  const blind = { model: mk('deepseek-flash', false), quality: 9, costUSD: 0.1, egress: 'deepseek', label: 'd' };
  const eyes = { model: mk('glm-5.3-flash', true), quality: 5, costUSD: 1, egress: 'zhipu', label: 'z' };
  const agent = await createAgent({ models: [blind, eyes], platform: quiet });
  try {
    const done1 = until(agent, (t) => t.state === 'SUCCEEDED');
    const t1 = await agent.run('这张截图里写了什么', { attachments: [{ name: '截图.png', size: png.length, note: '图片', image: { data: png, mime: 'image/png' } }] });
    await done1;
    assert.deepEqual(seen.at(-1), { model: 'glm-5.3-flash', images: 1, data: true }, '选能看图的，图片带上内容');
    assert.equal(t1.attachments![0]!.image?.mime, 'image/png');
    assert.equal((await agent.tasks.get(t1.id))!.tainted, true, '图片里也可能写着指令');

    // 不带图：照常选更合适的
    const done2 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === 'deepseek-flash 看完了');
    await agent.run('你好');
    await done2;

    // 追问：沿用之前的 5 张图 + 新给 1 张，只带最近的 4 张
    const many = Array.from({ length: 5 }, (_, i) => ({ ...t1.attachments![0]!, name: `旧${i}.png` }));
    const done3 = until(agent, (t) => t.state === 'SUCCEEDED' && t.outcome?.answer === 'glm-5.3-flash 看完了' && t.id !== t1.id);
    await agent.run('再看看', { attachments: [...many, { name: '新.png', size: png.length, note: '图片', image: { data: png, mime: 'image/png' } }] });
    await done3;
    assert.equal(seen.at(-1)!.images, 4);
  } finally { await agent.stop(); }

  // 只有看不了图的：说明白
  const only = await createAgent({ models: [{ model: mk('deepseek-flash', false), quality: 9, costUSD: 0.1, egress: 'deepseek', label: 'd' }], platform: quiet });
  try {
    const failed = until(only, (t) => t.state === 'FAILED');
    await only.run('看图', { attachments: [{ name: 'a.png', size: 3, note: '图片', image: { data: png, mime: 'image/png' } }] });
    const t = await failed;
    assert.match(t.outcome!.reason!, /当前启用的模型都看不了图/);
  } finally { await only.stop(); }
});

test('定制 Agent：各自的说明书进上下文；只能用勾选的技能（看不到、也调不了别的）；没定义的 Agent 不受限', async () => {
  const seen: { agent: string; tools: string[]; text: string }[] = [];
  const model = new ScriptedModel([]);
  let step = 0;
  model.generate = async (req) => {
    seen.push({ agent: String(req.meta?.agentId), tools: (req.tools ?? []).map((t) => t.name), text: req.messages.map((m) => m.content).join('\n') });
    step += 1;
    // 第一次：「创作助手」想偷偷调发邮件（没勾选）→ 应被拒
    if (step === 1) return call('mail.send', { to: 'a@example.com', subject: 's', body: 'b' });
    return { text: '好的', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const note = defineTool({ id: 'note.add', description: '记一条笔记', input: { text: 'string' }, risk: 'write', triggers: [], run: () => '记好了' });
  const mail = defineTool({ id: 'mail.send', description: '发邮件', input: { to: 'string', subject: 'string', body: 'string' }, risk: 'external', triggers: [], run: () => '已发送' });
  const agent = await createAgent({
    models: [{ model, quality: 1, costUSD: 1, egress: 'test', label: 'test' }], tools: [note, mail], platform: quiet,
    agents: [{ id: 'writer', name: '创作助手', instructions: '你是聊天记录风格的创作助手，只写虚构的人物和场景。', skills: ['note'] }],
    memory: true,
  });
  try {
    const done = until(agent, (t) => t.state === 'SUCCEEDED');
    const t = await agent.run('写一段对话', { agentId: 'writer' });
    await done;
    assert.match(seen[0]!.text, /你是聊天记录风格的创作助手/, '说明书进上下文');
    assert.ok(seen[0]!.tools.includes('note.add') && !seen[0]!.tools.includes('mail.send'), `只给勾选的：${seen[0]!.tools.join(',')}`);
    // 记忆也是一个技能（工具 id 虽是 builtin. 开头）：没勾就没有；读完整内容总在
    assert.ok(!seen[0]!.tools.some((x) => x.includes('memory')), `没勾记忆：${seen[0]!.tools.join(',')}`);
    assert.ok(seen[0]!.tools.includes('builtin.artifact_read'));
    const adm = (await agent.tasks.history(t.id)).map((r) => r.value).find((v) => v.t === 'AdmissionResolved') as unknown as { decision: string };
    assert.equal(adm.decision, 'deny', '模型硬调没勾选的工具：拒绝');

    // 默认 Agent（没定义）：不受限，也没有别人的说明书
    const before = seen.length;
    const done2 = until(agent, (x) => x.state === 'SUCCEEDED' && x.id !== t.id);
    await agent.run('随便聊聊');
    await done2;
    assert.ok(seen[before]!.tools.includes('mail.send') && seen[before]!.tools.includes('builtin.memory_write'));
    assert.doesNotMatch(seen[before]!.text, /创作助手/);
  } finally { await agent.stop(); }
});

test('画布：Agent 按格式生成、局部改；用户在界面上改的进下一轮上下文（以用户为准）；版本冲突、格式不对、回到旧版本', async () => {
  const kind = {
    kind: 'outline', name: '大纲', instructions: '大纲是 { title, items: string[] }。',
    schema: { type: 'object', required: ['title', 'items'], properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } },
  };
  const seen: { tools: string[]; text: string }[] = [];
  const model = new ScriptedModel([]);
  const plan: GenerateResult[] = [
    call('canvas.update', { ops: [{ op: 'replace', path: '', value: { title: '第一章', items: ['开头'] } }], note: '生成大纲' }),
    { text: '好了', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    // 第二轮：格式不对的先被退回，再局部追加
    call('canvas.update', { ops: [{ op: 'replace', path: '/items', value: 'x' }], note: '错的' }),
    call('canvas.update', { ops: [{ op: 'add', path: '/items/-', value: '结尾' }], note: '加结尾' }),
    { text: '加好了', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  const lasts: string[] = [];
  model.generate = async (req) => {
    seen.push({ tools: (req.tools ?? []).map((t) => t.name), text: req.messages.map((m) => m.content).join('\n') });
    lasts.push(String(req.messages.at(-1)?.content ?? ''));
    return plan.shift()!;
  };
  const events: number[] = [];
  const agent = await createAgent({ models: [{ model, quality: 1, costUSD: 1, egress: 'test', label: 'test' }], platform: quiet, canvasKinds: [kind] });
  agent.on('canvas', (v) => events.push(v.version));
  try {
    const c = { id: 'conv-1', kind: 'outline' };
    let done = until(agent, (t) => t.state === 'SUCCEEDED');
    const t1 = await agent.run('写个大纲', { canvas: c });
    await done;
    assert.ok(seen[0]!.tools.includes('canvas.update'), '绑定了画布才有画布工具');
    assert.match(seen[0]!.text, /大纲是 \{ title/, '这种画布的写法进上下文');
    assert.deepEqual((await agent.canvas.get('conv-1'))?.doc, { title: '第一章', items: ['开头'] });
    // 画布的状态放在前面：工具刚返回时，最后一条仍是工具结果（模型按它接着做）
    assert.match(lasts[1]!, /画布已更新到 v1/, `最后一条：${lasts[1]!.slice(0, 80)}`);

    // 用户在界面上改：基于 v1；之后再拿旧的 v1 改就冲突
    const e1 = await agent.canvas.edit('conv-1', 'outline', { ops: [{ op: 'replace', path: '/title', value: '序章' }], note: '标题改成序章', base: 1 });
    assert.equal(e1.ok, true);
    const stale = await agent.canvas.edit('conv-1', 'outline', { doc: { title: 'y', items: [] }, base: 1 });
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.conflict, true);
    const bad = await agent.canvas.edit('conv-1', 'outline', { doc: { title: 1 } });
    assert.equal(bad.ok, false, '格式不对不收');

    done = until(agent, (t) => t.state === 'SUCCEEDED' && t.id !== t1.id);
    await agent.run('再加个结尾', { canvas: c });
    await done;
    const ctx2 = seen[2]!.text;
    assert.match(ctx2, /"title":"序章"/, '当前内容是用户改过的');
    assert.match(ctx2, /用户在界面上改过.*标题改成序章/, '告诉 Agent 用户改了什么');
    assert.match(seen[3]!.text, /不符合「大纲」的格式/, '格式不对退回给模型');
    const v = await agent.canvas.get('conv-1');
    assert.deepEqual(v?.doc, { title: '序章', items: ['开头', '结尾'] }, '局部改，用户改的标题还在');
    assert.equal(v?.by, 'agent');

    const r = await agent.canvas.revert('conv-1', 1);
    assert.deepEqual(r?.doc, { title: '第一章', items: ['开头'] });
    assert.equal(r?.note, '回到 v1');
    assert.deepEqual(events, [1, 2, 3, 4], '每个新版本都发事件');
    assert.equal((await agent.canvas.history('conv-1')).length, 4);

    // 没绑画布的对话看不到画布工具
    plan.push({ text: 'hi', modelId: 'scripted', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
    const n = seen.length;
    done = until(agent, (t) => t.state === 'SUCCEEDED' && !t.canvas);
    await agent.run('随便聊聊');
    await done;
    assert.ok(!seen[n]!.tools.some((x) => x.startsWith('canvas.')));
  } finally { await agent.stop(); }
});
