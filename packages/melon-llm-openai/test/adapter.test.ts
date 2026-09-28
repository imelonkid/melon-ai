import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelTool } from '@melon-ai/core';
import { toolNameCodec } from '@melon-ai/core';
import { OpenAICompatibleChatModel } from '../src/index.js';

const TOOLS: ModelTool[] = [
  { name: 'doc.read', description: '读文档', input: { type: 'object', properties: {} } },
  { name: 'mail.send', description: '发邮件', input: { type: 'object', properties: {} } },
];

/** 造一个假的 fetch，记录请求并按脚本回复。 */
function fakeFetch(reply: unknown, captured: { body?: any } = {}) {
  return (async (_url: string, init: RequestInit) => {
    captured.body = JSON.parse(String(init.body));
    return { ok: true, status: 200, json: async () => reply } as unknown as Response;
  }) as unknown as typeof fetch;
}

const model = (f: typeof fetch) =>
  new OpenAICompatibleChatModel({
    model: 'stub', apiKey: 'k', baseURL: 'http://x/v1', fetchImpl: f,
  });

// ───────── 工具名转码（线上实测踩到的坑）─────────

test('工具名里的点号被转码 —— 供应商要求 ^[a-zA-Z0-9_-]+$', async () => {
  const cap: { body?: any } = {};
  await model(fakeFetch({ choices: [{ message: { content: 'ok' } }] }, cap))
    .generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  const names = cap.body.tools.map((t: any) => t.function.name);
  assert.deepEqual(names, ['doc_read', 'mail_send']);
  for (const n of names) assert.match(n, /^[a-zA-Z0-9_-]+$/);
});

test('返回的工具调用被映射回原始 id', async () => {
  const res = await model(fakeFetch({
    choices: [{
      message: {
        content: '先读文档',
        tool_calls: [{ id: 'c1', function: { name: 'doc_read', arguments: '{"query":"x"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  })).generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });

  assert.equal(res.toolCalls?.[0]?.name, 'doc.read', '必须还原成内核认识的 toolId');
  assert.deepEqual(res.toolCalls?.[0]?.args, { query: 'x' });
  assert.equal(res.stopReason, 'tool');
});

test('转码后碰撞会被去重 —— 否则模型的调用无法反解，是静默错路由', () => {
  const codec = toolNameCodec([
    { name: 'a.b', description: '', input: {} },
    { name: 'a-b', description: '', input: {} },
    { name: 'a_b', description: '', input: {} },
  ]);
  const names = codec.tools.map((t) => t.name);
  assert.equal(new Set(names).size, 3, '三个工具必须得到三个不同的名字');
  for (const t of ['a.b', 'a-b', 'a_b']) {
    assert.equal(codec.decode(codec.encode(t)), t, `${t} 必须能原样往返`);
  }
});

test('超长名字截断后仍保证唯一', () => {
  const long = (n: number) => 'x'.repeat(70) + n;
  const codec = toolNameCodec([
    { name: long(1), description: '', input: {} },
    { name: long(2), description: '', input: {} },
  ]);
  const names = codec.tools.map((t) => t.name);
  assert.equal(new Set(names).size, 2);
  for (const n of names) assert.ok(n.length <= 64, '供应商上限 64');
});

// ───────── 错误映射 ─────────

test('401 映射为 FATAL 并提示检查 key，不做无谓重试', async () => {
  const f = (async () => ({
    ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => model(f).generate({ messages: [{ role: 'user', content: 'x' }] }),
    (e: any) => e.code === 'FATAL' && /检查 API key/.test(e.hint ?? ''),
  );
});

test('429 映射为 RATE_LIMITED（管线会退避重试）', async () => {
  const f = (async () => ({
    ok: false, status: 429, json: async () => ({ error: { message: 'slow down' } }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => model(f).generate({ messages: [{ role: 'user', content: 'x' }] }),
    (e: any) => e.code === 'RATE_LIMITED' && e.retriable === true,
  );
});

test('400 映射为 INVALID_ARGS —— 参数问题重试必然再失败', async () => {
  const f = (async () => ({
    ok: false, status: 400, json: async () => ({ error: { message: 'bad name' } }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => model(f).generate({ messages: [{ role: 'user', content: 'x' }] }),
    (e: any) => e.code === 'INVALID_ARGS' && e.retriable === false,
  );
});

test('工具参数不是合法 JSON 时抛错，不静默当成空对象', async () => {
  const f = fakeFetch({
    choices: [{
      message: { tool_calls: [{ id: 'c', function: { name: 'doc_read', arguments: '{不是json' } }] },
    }],
  });
  await assert.rejects(
    () => model(f).generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }),
    (e: any) => e.code === 'INVALID_ARGS',
  );
});

test('没有 key 直接报错，不发请求', async () => {
  let called = false;
  const f = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
  const m = new OpenAICompatibleChatModel({ model: 's', apiKey: '', baseURL: 'http://x/v1', fetchImpl: f });
  await assert.rejects(() => m.generate({ messages: [] }), /缺少 API key/);
  assert.equal(called, false);
});
