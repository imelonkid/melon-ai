import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelTool } from '@melon-ai/core';
import { toolNameCodec } from '../../src/shared/toolname.js';
import { OpenAICompatibleChatModel } from '../../src/openai/index.js';

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

// ───────── 流式（SSE）─────────

/** 假的 SSE 响应：把整段事件流按任意字节边界切开发送 —— 真实网络里一个汉字可能被切在两个分片中间。 */
function sseFetch(events: readonly unknown[], cut = 7, captured: { body?: any } = {}) {
  const raw = new TextEncoder().encode(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''));
  return (async (_url: string, init: RequestInit) => {
    captured.body = JSON.parse(String(init.body));
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < raw.length; i += cut) c.enqueue(raw.slice(i, i + cut)); c.close(); },
    });
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('流式：边收边回调全文，汉字被切在分片中间也不乱码；用量取最后一个分片', async () => {
  const seen: string[] = [];
  const cap: { body?: any } = {};
  const res = await model(sseFetch([
    { model: 'deepseek-chat', choices: [{ delta: { content: '## 本周' } }] },
    { choices: [{ delta: { content: '要点\n- 一' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
    '[DONE]',
  ], 5, cap)).generate({ messages: [{ role: 'user', content: 'x' }], onText: (t) => seen.push(t) });

  assert.equal(cap.body.stream, true);
  assert.deepEqual(seen, ['## 本周', '## 本周要点\n- 一']);
  assert.equal(res.text, '## 本周要点\n- 一');
  assert.equal(res.modelId, 'deepseek-chat');
  assert.equal(res.stopReason, 'stop');
  assert.equal(res.usage.outputTokens, 5);
});

test('流式：工具调用的参数分片到达，拼完再解析并还原工具名', async () => {
  const res = await model(sseFetch([
    { choices: [{ delta: { content: '我先读一下' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'doc_read', arguments: '{"que' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"周报"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ])).generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, onText: () => {} });

  assert.equal(res.stopReason, 'tool');
  assert.equal(res.toolCalls?.[0]?.name, 'doc.read');
  assert.deepEqual(res.toolCalls?.[0]?.args, { query: '周报' });
});

test('流式：服务不支持、照常回了 JSON —— 当普通响应读，整段回调一次', async () => {
  const seen: string[] = [];
  const f = (async () => ({
    ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ choices: [{ message: { content: '整段' } }] }),
  })) as unknown as typeof fetch;
  const res = await model(f).generate({ messages: [{ role: 'user', content: 'x' }], onText: (t) => seen.push(t) });
  assert.equal(res.text, '整段');
  assert.deepEqual(seen, ['整段']);
});

test('不要流式就不发 stream 参数', async () => {
  const cap: { body?: any } = {};
  await model(fakeFetch({ choices: [{ message: { content: 'ok' } }] }, cap)).generate({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cap.body.stream, undefined);
});

// ───────── 思考过程（推理模型的 reasoning_content）─────────

test('思考：流式里的 reasoning_content 单独回调、单独返回，不混进回答', async () => {
  const thoughts: string[] = [];
  const texts: string[] = [];
  const res = await model(sseFetch([
    { choices: [{ delta: { reasoning_content: '用户要的是' } }] },
    { choices: [{ delta: { reasoning_content: '本周要点' } }] },
    { choices: [{ delta: { content: '## 本周要点' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ])).generate({ messages: [{ role: 'user', content: 'x' }], onText: (t) => texts.push(t), onReasoning: (t) => thoughts.push(t) });
  assert.deepEqual(thoughts, ['用户要的是', '用户要的是本周要点']);
  assert.deepEqual(texts, ['## 本周要点']);
  assert.equal(res.reasoning, '用户要的是本周要点');
  assert.equal(res.text, '## 本周要点');
});

test('思考：只要思考不要正文（必须调工具的一轮）也走流式', async () => {
  const cap: { body?: any } = {};
  const thoughts: string[] = [];
  const res = await model(sseFetch([
    { choices: [{ delta: { reasoning_content: '先搜一下' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'doc_read', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ], 9, cap)).generate({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, onReasoning: (t) => thoughts.push(t) });
  assert.equal(cap.body.stream, true);
  assert.deepEqual(thoughts, ['先搜一下']);
  assert.equal(res.toolCalls?.[0]?.name, 'doc.read');
});

test('思考：非流式响应里的 reasoning_content 也带上', async () => {
  const res = await model(fakeFetch({ choices: [{ message: { content: '答', reasoning_content: '想' } }] }))
    .generate({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.reasoning, '想');
  assert.equal(res.text, '答');
});

test('用量：DeepSeek 用 prompt_cache_hit_tokens 报缓存命中，也要读到', async () => {
  const res = await model(fakeFetch({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
  })).generate({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.usage.cachedInputTokens, 600);
});

test('模型发现：GET /models 列出这个账号能用的模型', async () => {
  const cap: { url?: string } = {};
  const f = (async (url: string) => {
    cap.url = url;
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }) };
  }) as unknown as typeof fetch;
  assert.deepEqual(await model(f).listModels(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(cap.url, 'http://x/v1/models');
});

test('余额不足不报成限流：智谱的 429「余额不足或无可用资源包」、DeepSeek 的 402 → FATAL「余额不足」，不重试', async () => {
  for (const [status, message] of [[429, '余额不足或无可用资源包,请充值。'], [402, 'Insufficient Balance']] as const) {
    const f = (async () => ({ ok: false, status, json: async () => ({ error: { message } }) })) as unknown as typeof fetch;
    await assert.rejects(
      () => model(f).generate({ messages: [{ role: 'user', content: 'x' }] }),
      (e: any) => e.code === 'FATAL' && e.retriable === false && /^余额不足/.test(e.message) && /充值/.test(e.hint ?? ''),
    );
  }
});

test('看图：图片发成 image_url（data URL）；按模型名判断能不能看图（路由据此决定谁收到图）', async () => {
  const { visionByName } = await import('../../src/shared/vision.js');
  for (const id of ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-5v-turbo', 'glm-4.5v', 'qwen-vl-max', 'qwen3-vl-plus', 'gpt-4o-mini', 'gpt-5', 'claude-sonnet-5']) assert.equal(visionByName(id), true, id);
  for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.2', 'qwen-max', 'moonshot-v1-128k']) assert.equal(visionByName(id), false, id);
  let body: any = null;
  const f = (async (_u: string, init: any) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '看到了' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  }) as unknown as typeof fetch;
  const msg = { role: 'user' as const, content: '【图片】截图.png', images: [{ ref: 'a' as never, mime: 'image/png', data: 'AAAA' }] };
  const { OpenAICompatibleChatModel } = await import('../../src/openai/adapter.js');
  const vis = new OpenAICompatibleChatModel({ baseURL: 'http://x/v1', apiKey: 'k', model: 'glm-5.3-flash', fetchImpl: f });
  assert.equal(vis.capabilities.vision, true);
  await vis.generate({ messages: [msg] });
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: '【图片】截图.png' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  const blind = new OpenAICompatibleChatModel({ baseURL: 'http://x/v1', apiKey: 'k', model: 'deepseek-flash', fetchImpl: f });
  assert.equal(blind.capabilities.vision, false, '看不了图：路由不会把带图的一轮给它');
});

test('关思考：DeepSeek、智谱带 thinking: { type: "disabled" }；强制思考的 GLM-5.3 / 5.3-Flash 和不认识这个参数的厂商不带', async () => {
  const body = async (preset: 'deepseek' | 'zhipu' | 'openai', m: string, thinking?: 'off' | 'auto' | 'low' | 'medium' | 'high') => {
    const cap: { body?: any } = {};
    await new OpenAICompatibleChatModel({ model: m, preset, apiKey: 'k', baseURL: 'http://x/v1', fetchImpl: fakeFetch({ choices: [{ message: { content: 'ok' } }] }, cap) })
      .generate({ messages: [{ role: 'user', content: 'x' }], ...(thinking ? { thinking } : {}) });
    return cap.body;
  };
  assert.deepEqual((await body('deepseek', 'deepseek-flash', 'off')).thinking, { type: 'disabled' });
  assert.deepEqual((await body('zhipu', 'glm-4.7', 'off')).thinking, { type: 'disabled' });
  assert.equal((await body('zhipu', 'glm-5.3-flash', 'off')).thinking, undefined, '强制思考的不带（带了也关不掉）');
  assert.equal((await body('openai', 'gpt-4o', 'off')).thinking, undefined);
  assert.equal((await body('deepseek', 'deepseek-flash')).thinking, undefined, '没说就不管（用厂商的默认）');
  assert.equal((await body('deepseek', 'deepseek-flash', 'auto')).thinking, undefined);
});

test('思考力度：DeepSeek 只有 low / high / max —— 低、中用 low，高用 high；智谱没有力度（照默认思考）；别家不带', async () => {
  const body = async (preset: 'deepseek' | 'zhipu' | 'openai', m: string, thinking: 'low' | 'medium' | 'high') => {
    const cap: { body?: any } = {};
    await new OpenAICompatibleChatModel({ model: m, preset, apiKey: 'k', baseURL: 'http://x/v1', fetchImpl: fakeFetch({ choices: [{ message: { content: 'ok' } }] }, cap) })
      .generate({ messages: [{ role: 'user', content: 'x' }], thinking });
    return cap.body;
  };
  assert.equal((await body('deepseek', 'deepseek-flash', 'low')).reasoning_effort, 'low');
  assert.equal((await body('deepseek', 'deepseek-flash', 'medium')).reasoning_effort, 'low');
  assert.equal((await body('deepseek', 'deepseek-flash', 'high')).reasoning_effort, 'high');
  assert.equal((await body('deepseek', 'deepseek-flash', 'high')).thinking, undefined, '开着思考就用默认的开关');
  const z = await body('zhipu', 'glm-4.7', 'high');
  assert.equal(z.reasoning_effort, undefined); assert.equal(z.thinking, undefined);
  assert.equal((await body('openai', 'gpt-4o', 'medium')).reasoning_effort, undefined);
});
