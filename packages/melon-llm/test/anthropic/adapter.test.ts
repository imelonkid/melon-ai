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
