import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedModel } from '@melon-ai/testkit';
import { consoleLogger, createAgent } from '../src/index.js';
import { nodePlatform } from '../src/node.js';
import type { MelonAgent, Task } from '../src/index.js';
import { createAdmin, InMemoryAdminStore } from '../src/admin.js';

/** 宿主接后台：每个用户一个引擎实例，`...admin.meter(id)` 一行接上额度和记账。 */

const quiet = { ...nodePlatform(), logger: consoleLogger({ min: 'error', sink: () => {} }) };
function until(agent: MelonAgent, pred: (t: Task) => boolean, ms = 3000): Promise<Task> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('等待超时')); }, ms);
    const off = agent.on('task', (t) => { if (pred(t)) { clearTimeout(timer); off(); resolve(t); } });
  });
}

test('后台接入：用量进后台（onUsage）、算额度；额度用完后这个用户的任务以后台给的原因结束', async () => {
  const admin = createAdmin({ store: new InMemoryAdminStore(), principals: { list: () => [{ id: 'u1', name: '小林' }] }, auth: { verify: () => null } });
  const model = new ScriptedModel(['第一次的回答', '第二次不该被问到']);
  // 每次 10 输入 + 5 输出；每百万 token 10 万元 → 每次 1.5 元
  const priced = { model, quality: 5, costUSD: 1, egress: 'test', label: 'test', price: { input: 100_000, output: 100_000, currency: 'CNY' as const } };
  const agent = await createAgent({ models: [priced], platform: quiet, ...admin.meter('u1') });
  try {
    await admin.quota.setPolicy('u1', { mode: 'custom', amounts: { day: 1, '5h': 10 } });
    const d1 = until(agent, (t) => t.state === 'SUCCEEDED');
    await agent.run('你好');
    await d1;
    await new Promise((r) => setTimeout(r, 20));
    const s = await admin.status('u1');
    assert.ok(s.windows[0]!.used >= 1, `used=${s.windows[0]!.used}`);
    const d2 = until(agent, (t) => t.state === 'FAILED');
    await agent.run('再来一句');
    const failed = await d2;
    assert.match(failed.outcome?.reason ?? '', /今天的额度（¥1）用完了/);
  } finally { await agent.stop(); }
});
