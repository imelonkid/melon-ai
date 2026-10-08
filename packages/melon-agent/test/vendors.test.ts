import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_VENDORS, providerFrom } from '../src/index.js';

test('引擎自带的模型厂商：表单描述 + 按填好的值造 ModelProvider（账户、分组、优先级、只用这些模型）', () => {
  assert.deepEqual(MODEL_VENDORS.map((v) => v.id), ['deepseek', 'qwen', 'zhipu', 'kimi', 'openai']);
  assert.equal(providerFrom('deepseek', { apiKey: '' }), null, '没填 key');
  assert.equal(providerFrom('nope', { apiKey: 'k' }), null, '认不出的厂商');
  const p = providerFrom('deepseek', { apiKey: 'sk-1', models: 'deepseek-flash, deepseek-v4-pro' }, { id: 'shared:deepseek', group: 'shared', priority: 1 })!;
  assert.deepEqual([p.vendor, p.id, p.group, p.priority], ['deepseek', 'shared:deepseek', 'shared', 1]);
  assert.equal(p.make().model.id, 'deepseek-flash', '默认用列表里的第一个');
  assert.throws(() => p.make('deepseek-reasoner'), /没选用这个模型/);
  assert.ok(!String(p.fingerprint).includes('sk-1'), '指纹不含 key');
  assert.notEqual(providerFrom('deepseek', { apiKey: 'sk-2' })!.fingerprint, providerFrom('deepseek', { apiKey: 'sk-1' })!.fingerprint);
});
