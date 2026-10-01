import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDeepseekPricing, deepseekPrices } from '../src/deepseek/index.js';
import { parseAnthropicPricing, anthropicModelId } from '../src/anthropic/index.js';
import { parseZhipuPricing } from '../src/zhipu/index.js';
import { parseKimiPricing } from '../src/kimi/index.js';
import { parseQwenPricing } from '../src/qwen/index.js';

/**
 * 价格文档的样本是 2026-10 从各家官方文档原样存下来的（通义的页面太大，截了前 30 张表）。
 * 文档改版后这些测试照样过 —— 真正盯改版的是线上同步：解析不出来会报「格式可能变了」并保留上次的价格。
 */
const fx = (f: string): string => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');

test('DeepSeek：表里的模型、缓存命中 / 未命中 / 输出（空闲价）、高峰 ×2 与时段、旧模型名按 Flash 计', () => {
  const s = parseDeepseekPricing(fx('deepseek-pricing.html'));
  const f = s.prices['deepseek-flash']!;
  assert.deepEqual([f.input, f.cachedInput, f.output, f.currency], [1, 0.02, 4, 'CNY']);
  assert.deepEqual(f.peak, {
    multiplier: 2, timeZone: 'Asia/Shanghai',
    windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '12:00' }, { days: [1, 2, 3, 4, 5], from: '14:00', to: '18:00' }],
  });
  assert.deepEqual([s.prices['deepseek-v4-pro']!.input, s.prices['deepseek-v4-pro']!.output], [4.5, 13.5]);
  assert.equal(s.prices['deepseek-v4-flash'], f);
});

test('DeepSeek：页面改版读不到表时明确报错（引擎据此保留上次的价格）', async () => {
  assert.throws(() => parseDeepseekPricing('<html>维护中</html>'), /没有价格表/);
  const src = deepseekPrices({ fetchImpl: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch });
  await assert.rejects(() => src.fetch(AbortSignal.timeout(1000)), /HTTP 503/);
});

test('Claude：展示名换成模型 id，读输入 / 缓存命中 / 输出（美元）', () => {
  assert.equal(anthropicModelId('Claude Opus 5.5'), 'claude-opus-5-5');
  assert.equal(anthropicModelId('Claude Mythos 5.1 ([limited availability](https://x))'), 'claude-mythos-5-1');
  const s = parseAnthropicPricing(fx('anthropic-pricing.md'));
  assert.deepEqual(Object.values(s.prices).every((p) => p.currency === 'USD'), true);
  const f = s.prices['claude-fable-5-1']!;
  assert.deepEqual([f.input, f.cachedInput, f.output], [10, 0.25, 50]);
  assert.ok(s.prices['claude-haiku-4-5'], '老模型也在表里');
});

test('智谱：文本 / 视觉模型的表，展示名转小写 id；分档的取最低一档', () => {
  const s = parseZhipuPricing(fx('zhipu-pricing.md'));
  assert.deepEqual([s.prices['glm-5.3-flash']!.input, s.prices['glm-5.3-flash']!.cachedInput, s.prices['glm-5.3-flash']!.output], [0.8, 0.23, 2.8]);
  assert.deepEqual([s.prices['glm-5.1']!.input, s.prices['glm-5.1']!.output], [6, 24], 'GLM-5.1 [0, 32K) 档');
  assert.deepEqual(s.notes, ['按输入长度分档的模型取最低一档']);
  assert.equal(s.prices['glm-ocr']!.cachedInput, undefined, '「不支持」缓存的不填缓存价');
});

test('Kimi：DocTable 组件里的表，按列名取缓存命中 / 未命中 / 输出', () => {
  const s = parseKimiPricing(fx('kimi-pricing.md'));
  const k3 = s.prices['kimi-k3']!;
  assert.deepEqual([k3.input, k3.cachedInput, k3.output], [20, 2, 100]);
  assert.deepEqual([s.prices['kimi-k2.6']!.input, s.prices['kimi-k2.6']!.cachedInput], [6.5, 1.1]);
});

test('通义：模型 ID 表取第一次出现的（中国内地）、第一档；没写缓存价', () => {
  const s = parseQwenPricing(fx('qwen-pricing.html'));
  assert.deepEqual([s.prices['qwen-max']!.input, s.prices['qwen-max']!.output], [2.4, 9.6]);
  assert.deepEqual([s.prices['qwen3.8-max']!.input, s.prices['qwen3.8-max']!.output], [12, 36], '不是国际站的 14.988');
  assert.equal(s.prices['qwen-max']!.cachedInput, undefined);
});
