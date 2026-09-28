import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatModel } from '@melon-ai/core';
import { HeuristicTokenizer, PolicyRouter } from '../src/index.js';

const fake = (id: string): ChatModel => ({
  id,
  capabilities: { contextWindow: 1000, maxOutputTokens: 100, tools: true, jsonSchema: true, promptCache: true },
  generate: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, modelId: id, stopReason: 'stop' }),
});

const entries = [
  { model: fake('opus'), quality: 10, costUSD: 5, egress: 'anthropic' },
  { model: fake('deepseek'), quality: 6, costUSD: 0.3, egress: 'deepseek' },
  { model: fake('qwen'), quality: 5, costUSD: 0.5, egress: 'aliyun' },
];

test('quality 策略选最强的', async () => {
  const r = await new PolicyRouter(entries, 'quality').select('answer');
  assert.equal(r.primary.id, 'opus');
  assert.deepEqual(r.fallbacks.map((m) => m.id), ['deepseek', 'qwen']);
});

test('cost 策略选最便宜的', async () => {
  assert.equal((await new PolicyRouter(entries, 'cost').select('answer')).primary.id, 'deepseek');
});

test('classify / extract 无论全局策略都走便宜的', async () => {
  for (const intent of ['classify', 'extract'] as const) {
    const r = await new PolicyRouter(entries, 'quality').select(intent);
    assert.equal(r.primary.id, 'deepseek', '辅助调用用最强模型是纯浪费');
  }
});

test('balanced 下 plan 提升为 quality', async () => {
  assert.equal((await new PolicyRouter(entries, 'balanced').select('plan')).primary.id, 'opus');
  assert.equal((await new PolicyRouter(entries, 'balanced').select('answer')).primary.id, 'deepseek');
});

test('egress 覆盖全部候选 —— 数据可能发往任何一个', async () => {
  const r = await new PolicyRouter(entries, 'quality').select('plan');
  assert.deepEqual([...r.egress].sort(), ['aliyun', 'anthropic', 'deepseek']);
});

test('不健康的模型被降权，冷却后恢复', async () => {
  let now = 0;
  const router = new PolicyRouter(entries, 'quality', () => now, 1000);
  router.markUnhealthy('opus');
  assert.equal((await router.select('answer')).primary.id, 'deepseek');
  now = 1001;
  assert.equal((await router.select('answer')).primary.id, 'opus');
});

test('全都不健康时不返回空 —— 宁可试一个也别让任务直接死', async () => {
  const router = new PolicyRouter(entries, 'quality');
  for (const e of entries) router.markUnhealthy(e.model.id);
  assert.ok((await router.select('answer')).primary);
});

test('禁用的模型不进候选', async () => {
  const r = await new PolicyRouter(
    [...entries.slice(1), { ...entries[0]!, enabled: false }], 'quality',
  ).select('answer');
  assert.notEqual(r.primary.id, 'opus');
});

test('分词器对中文不按 4 字符估算', () => {
  const t = new HeuristicTokenizer();
  assert.ok(t.count('汇总本周进展') >= 6, 'CJK 应按字符计');
  assert.ok(t.count('abcdefgh') <= 3);
});
