import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateResult, ModelEntry } from '@melon-ai/core';
import { ScriptedModel } from '@melon-ai/testkit';
import { consoleLogger, createAgent, defineTool, nodePlatform } from '../src/index.js';
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

test('when：只在满足条件的任务里把工具给模型', async () => {
  const propose = defineTool({ id: 'task.propose', description: '拟任务', when: (t) => t.trigger.ref?.startsWith('chat:') ?? false, run: () => '' });
  const { entry: e, model } = entry(['好', '好']);
  const agent = await createAgent({ models: [e], tools: [propose], platform: quiet });
  try {
    await agent.run('查一下', {});
    await agent.run('每周发周报', { ref: 'chat:1' });
    await agent.drain();
    const toolNames = model.calls.map((c) => (c.tools ?? []).map((t) => t.name));
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
  const mailSend = defineTool({ id: 'mail.send', description: '', risk: 'external', input: { to: 'string' }, run: () => 'ok' });
  const { entry: e } = entry([call('mail.send', { to: 'x' })]);
  const agent = await createAgent({ models: [e], tools: [mailSend], platform: quiet });
  const waiting = until(agent, (t) => t.state === 'AWAITING_APPROVAL');
  const task = await agent.run('发');
  await waiting;
  let ended = false;
  const loop = (async () => { for await (const _ of agent.watch(task.id)) { /* 读空 */ } ended = true; })();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ended, false, '任务还在等人，watch 不该自己结束');
  await agent.stop();
  await Promise.race([loop, new Promise((r) => setTimeout(r, 500))]);
  assert.equal(ended, true, 'stop 之后 watch 必须收尾');
});

test('联网技能：@melon-ai/agent/web 按需开启；没配搜索只有读网页，configure 后搜索出现', async () => {
  const { web } = await import('../src/web.js');
  const agent = await createAgent({ skills: [web()], platform: quiet });
  try {
    assert.deepEqual(agent.tools.list().map((d) => d.id), ['web.fetch']);
    const backend = { id: 'fake', search: async () => [] };
    await agent.configure({ skills: [web({ search: backend })] });
    assert.deepEqual(agent.tools.list().map((d) => d.id).sort(), ['web.fetch', 'web.search']);
    assert.ok(agent.tools.list().every((d) => d.untrustedOutput), '联网工具都得声明输出不可信');
  } finally { await agent.stop(); }
});
