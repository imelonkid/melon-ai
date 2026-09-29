import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel, ModelEntry } from '@melon-ai/core';
import { ModelPool, compatible, deepseek, kimi, openai, qwen, testModel } from '../../src/index.js';
import { claude } from '../../src/anthropic/index.js';

const fake = (id: string, reply: () => Promise<string>): ModelEntry => ({
  label: id,
  model: {
    id,
    capabilities: { contextWindow: 1000, maxOutputTokens: 100, tools: true, jsonSchema: true, promptCache: false },
    async generate() {
      return { text: await reply(), modelId: id, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, costUSD: 0.001 } };
    },
  } as unknown as ChatModel,
  quality: 5, costUSD: 1, egress: id,
});

test('模型池：没有模型时 select 明确报错，而不是卡住', async () => {
  const pool = new ModelPool();
  assert.equal(pool.ready, false);
  await assert.rejects(() => pool.select('plan'), /没有可用的模型/);
});

test('模型池：热替换后立即生效，策略一并替换', async () => {
  const pool = new ModelPool();
  pool.set([fake('a', async () => 'ok')], 'cost');
  assert.equal(pool.ready, true);
  assert.equal((await pool.select('plan')).primary.id, 'a');
  assert.equal(pool.current.strategy, 'cost');
  pool.set([]);
  assert.equal(pool.ready, false);
});

test('testModel：成功带耗时与样例，失败带错误码与提示', async () => {
  const ok = await testModel(fake('a', async () => 'ok'));
  assert.equal(ok.ok, true);
  assert.equal(ok.sample, 'ok');
  const bad = await testModel(fake('b', async () => {
    throw Object.assign(new Error('key 无效'), { code: 'DENIED', hint: '检查 key' });
  }));
  assert.deepEqual([bad.ok, bad.code, bad.error, bad.hint], [false, 'DENIED', 'key 无效', '检查 key']);
});

test('各家工厂：默认模型、名字与出境标识；可覆盖模型名与路由属性', () => {
  const d = deepseek({ apiKey: 'k' });
  assert.deepEqual([d.label, d.model.id, d.egress], ['DeepSeek', 'deepseek-chat', 'deepseek']);
  assert.equal(qwen({ apiKey: 'k' }).egress, 'aliyun');
  assert.equal(openai({ apiKey: 'k', model: 'gpt-5', quality: 9 }).model.id, 'gpt-5');
  assert.equal(openai({ apiKey: 'k', quality: 9 }).quality, 9);
  assert.equal(kimi({ apiKey: 'k' }).egress, 'moonshot');
  const c = claude({ apiKey: 'k' });
  assert.deepEqual([c.label, c.model.id, c.egress, c.costUSD], ['Claude', 'claude-opus-5', 'anthropic', 5]);
});

test('compatible：任意 OpenAI 兼容供应商，名字与出境标识按宿主给的记', () => {
  const z = compatible({ label: '智谱', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', apiKey: 'k', egress: 'zhipu' });
  assert.deepEqual([z.label, z.model.id, z.egress, z.quality], ['智谱', 'glm-4', 'zhipu', 5]);
});
