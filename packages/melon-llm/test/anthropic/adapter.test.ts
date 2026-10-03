import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicChatModel } from '../../src/anthropic/index.js';

/** 本地假服务：按 Anthropic 的 SSE 事件格式回一段「思考 + 正文 + 工具调用」。 */
async function fakeServer(events: readonly [string, unknown][]) {
  const seen: { body?: any } = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const usage = { input_tokens: 10, output_tokens: 0 };

test('流式：正文与思考分开交（思考块不算回答），全文累加；工具调用照常还原', async () => {
  const srv = await fakeServer([
    ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我先' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '读一下' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'doc_read', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":"周报"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  try {
    const seen: string[] = [];
    const thoughts: string[] = [];
    const res = await new AnthropicChatModel({ apiKey: 'k', baseURL: srv.url, model: 'claude-opus-5' }).generate({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'doc.read', description: '读文档', input: { type: 'object', properties: {} } }],
      onText: (t) => seen.push(t),
      onReasoning: (t) => thoughts.push(t),
    });
    assert.deepEqual(thoughts, ['想一想']);
    assert.equal(res.reasoning, '想一想');
    assert.equal(srv.seen.body.stream, true);
    assert.deepEqual(seen, ['我先', '我先读一下']);
    assert.equal(res.text, '我先读一下');
    assert.equal(res.stopReason, 'tool');
    assert.equal(res.toolCalls?.[0]?.name, 'doc.read');
    assert.deepEqual(res.toolCalls?.[0]?.args, { query: '周报' });
  } finally {
    await srv.close();
  }
});

test('模型发现与新模型：/v1/models 列出模型；目录里没有的模型 id 也能用（默认上限、不计价），网关可以换厂商标识', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    // 目录里没有的模型：默认上限
    const m = new AnthropicChatModel({ apiKey: 'k', baseURL: `http://127.0.0.1:${port}`, model: 'claude-future-9' });
    assert.deepEqual(await m.listModels(), ['claude-opus-5-5']);
    assert.equal(m.capabilities.contextWindow, 200_000);
  } finally {
    await new Promise((r) => server.close(r));
  }
  const { claude } = await import('../../src/anthropic/index.js');
  const e = claude({ apiKey: 'k', model: 'qwen3.7-plus', egress: 'aliyun-coding', label: '阿里 Coding Plan' });
  assert.deepEqual([e.model.id, e.egress, e.label, e.price, e.tier], ['qwen3.7-plus', 'aliyun-coding', '阿里 Coding Plan', undefined, undefined]);
  assert.equal(claude({ apiKey: 'k' }).priceSource, 'builtin');
  assert.equal(claude({ apiKey: 'k', price: { input: 1, output: 1, currency: 'USD' } }).priceSource, 'manual');
});

test('思考力度：关 → 不开思考；低 / 中 / 高 → 自适应思考 + 对应的 effort；不说 → 自适应 + high（原来的默认）', async () => {
  const run = async (thinking?: 'off' | 'low' | 'medium' | 'high') => {
    const srv = await fakeServer([
      ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
    try {
      await new AnthropicChatModel({ apiKey: 'k', baseURL: srv.url, model: 'claude-opus-5' }).generate({
        messages: [{ role: 'user', content: 'x' }], onText: () => {}, ...(thinking ? { thinking } : {}),
      });
      return srv.seen.body;
    } finally { await srv.close(); }
  };
  const off = await run('off');
  assert.equal(off.thinking, undefined);
  const mid = await run('medium');
  assert.deepEqual(mid.thinking, { type: 'adaptive' });
  assert.equal(mid.output_config.effort, 'medium');
  assert.equal((await run('low')).output_config.effort, 'low');
  assert.equal((await run()).output_config.effort, 'high');
});
