import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanStep, ToolDescriptor, ToolsetSnapshot } from '@melon-ai/core';
import { asSkillId, asToolId } from '@melon-ai/core';
import { openSqliteStores } from '@melon-ai/store-sqlite';
import {
  ScriptedPlanner, StaticToolResolver, StructuralValidator, noTools,
} from '@melon-ai/testkit';
import { consoleLogger, createAgent, nodePlatform } from '../src/index.js';
import type { MelonAgent } from '../src/index.js';

const MAIL = asToolId('mail.send');
const mailDesc: ToolDescriptor = {
  id: MAIL, skillId: asSkillId('mail'), name: 'send', description: '发邮件',
  input: { required: ['to'], properties: { to: { type: 'string' } } },
  risk: 'external', idempotent: false, scopeKeys: ['to'],
};
const TOOLSET: ToolsetSnapshot = { takenAt: 0, skills: [{ id: asSkillId('mail'), version: '1' }] };

const mailCall = () => ({
  callId: 'c-1' as never, toolId: MAIL, args: { to: '产品组' }, argsHash: 'h1',
});
const spec = () => ({
  agentId: 'weekly' as never, kind: 'conversation' as const,
  goal: '发周报', trigger: { type: 'manual' as const },
});

interface Ctx { agent: MelonAgent; dir: string; sent: () => number; close: () => Promise<void>; }

async function boot(opts: {
  dir?: string;
  script: readonly PlanStep[];
  policy?: 'ask' | 'all-auto';
}): Promise<Ctx> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'melon-int-'));
  const stores = openSqliteStores({ file: join(dir, 'agent.db') });
  let sent = 0;
  const resolver = new StaticToolResolver().add({
    descriptor: mailDesc,
    handler: async () => { sent++; return { summary: '已发送给 6 人' }; },
  });
  const agent = await createAgent({
    stores,
    planner: new ScriptedPlanner(opts.script),
    resolver,
    validator: new StructuralValidator(),
    // 日志静音，否则测试输出被 span 刷满
    platform: { ...nodePlatform(), logger: consoleLogger({ min: 'error', sink: () => {} }) },
    policy: opts.policy ?? 'all-auto',
    availableTools: async () => noTools,
    toolset: () => TOOLSET,
    pollIntervalMs: 0,
    execute: { timeoutMs: 500, maxRetries: 0, backoffBaseMs: 0 },
  });
  return { agent, dir, sent: () => sent, close: async () => { await agent.stop(); await stores.close(); } };
}

test('createAgent：最简任务跑通，真持久化', async () => {
  const c = await boot({ script: [{ kind: 'final', thought: 'x', answer: '好了' }] });
  try {
    const t = await c.agent.submit(spec());
    await c.agent.drain();
    const final = await c.agent.get(t.id);
    assert.equal(final?.state, 'SUCCEEDED');
    assert.equal(final?.outcome?.answer, '好了');
  } finally { await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test('createAgent：工具调用 + 审计链完整', async () => {
  const c = await boot({
    script: [
      { kind: 'tool_call', thought: '发', call: mailCall() },
      { kind: 'final', thought: '完成', answer: '已发送' },
    ],
  });
  try {
    const t = await c.agent.submit(spec());
    await c.agent.drain();
    assert.equal((await c.agent.get(t.id))?.state, 'SUCCEEDED');
    assert.equal(c.sent(), 1);
    assert.equal(await c.agent.audit.verify(), null, '审计哈希链必须完整');
  } finally { await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test('createAgent：watch 能驱动宿主 UI', async () => {
  const c = await boot({
    script: [
      { kind: 'tool_call', thought: '发', call: mailCall() },
      { kind: 'final', thought: '完成', answer: '已发送' },
    ],
  });
  try {
    const t = await c.agent.submit(spec());
    const seen: string[] = [];
    const done = (async () => {
      for await (const e of c.agent.watch(t.id)) seen.push(e.value.t);
    })();
    await c.agent.drain();
    await done;
    assert.ok(seen.includes('ApprovalRequested') === false);
    assert.ok(seen.includes('Observed'));
    assert.equal(seen[seen.length - 1], 'Settled');
  } finally { await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test('P0 完整验收：真数据库 + 重启 + 跨进程审批', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melon-p0-'));
  let taskId: string;
  try {
    // ① 第一个「进程」：跑到等审批，然后关掉（连数据库一起关）
    {
      const c = await boot({ dir, policy: 'ask', script: [{ kind: 'tool_call', thought: '发', call: mailCall() }] });
      const t = await c.agent.submit(spec());
      taskId = t.id;
      await c.agent.drain();
      assert.equal((await c.agent.get(t.id))?.state, 'AWAITING_APPROVAL');
      assert.equal(c.sent(), 0, '等审批期间绝不能执行');
      await c.close();
    }
    // ② 第二个「进程」：重新打开同一个数据库文件
    {
      const c = await boot({
        dir, policy: 'ask',
        script: [{ kind: 'final', thought: '完成', answer: '周报已发送' }],
      });
      try {
        await c.agent.start();
        await c.agent.drain();
        const restored = await c.agent.get(taskId as never);
        assert.equal(restored?.state, 'AWAITING_APPROVAL', '等人的状态恢复后不该被改动');
        assert.equal(c.sent(), 0);

        await c.agent.resolveApproval(taskId as never, 'c-1', 'allow');
        await c.agent.drain();

        const final = await c.agent.get(taskId as never);
        assert.equal(final?.state, 'SUCCEEDED');
        assert.equal(final?.outcome?.answer, '周报已发送');
        assert.equal(c.sent(), 1, '跨进程批准后才真正发送');
        assert.equal(await c.agent.audit.verify(), null, '审计链跨进程仍然完整');
      } finally { await c.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('保留期配置非法时 createAgent 直接拒绝启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melon-ret-'));
  const stores = openSqliteStores({ file: join(dir, 'a.db') });
  try {
    await assert.rejects(() => createAgent({
      stores,
      planner: new ScriptedPlanner([]),
      resolver: new StaticToolResolver(),
      validator: new StructuralValidator(),
      platform: nodePlatform(),
      retention: { auditDays: 365, payloadDays: 90, keepForever: [] },
    }), /负载保留期/);
  } finally { await stores.close(); rmSync(dir, { recursive: true, force: true }); }
});
