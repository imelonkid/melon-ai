import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bocha } from '../src/bocha/index.js';

const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? 'NONE'; }
};

async function stubBocha(handler: (auth: string, body: Record<string, unknown>) => { status: number; json: unknown }) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const out = handler(String(req.headers.authorization ?? ''), JSON.parse(raw || '{}'));
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/web-search`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('博查：按官方字段发请求、解析 data.webPages.value', async () => {
  let got: { auth: string; body: Record<string, unknown> } | undefined;
  const s = await stubBocha((auth, body) => {
    got = { auth, body };
    return { status: 200, json: { code: 200, data: { webPages: { value: [
      { name: '标题', url: 'https://a.test', summary: '摘要', siteName: '站点', datePublished: '2026-09-28T10:00:00+08:00' },
    ] } } } };
  });
  try {
    const hits = await bocha({ apiKey: 'k1', baseURL: s.url })
      .search({ query: 'AI', freshness: 'oneWeek', count: 3 }, new AbortController().signal);
    assert.equal(got?.auth, 'Bearer k1');
    assert.deepEqual(got?.body, { query: 'AI', summary: true, freshness: 'oneWeek', count: 3 });
    assert.deepEqual(hits, [{ title: '标题', url: 'https://a.test', summary: '摘要', site: '站点', date: '2026-09-28' }]);
  } finally { await s.close(); }
});

test('博查：key 无效是 DENIED（重试没用），业务错误码是 UPSTREAM', async () => {
  const s = await stubBocha((auth) => (auth === 'Bearer bad'
    ? { status: 401, json: { code: 401 } }
    : { status: 200, json: { code: 402, msg: '余额不足' } }));
  try {
    const q = { query: 'x', freshness: 'noLimit' as const, count: 1 };
    assert.equal(await code(bocha({ apiKey: 'bad', baseURL: s.url }).search(q, new AbortController().signal)), 'DENIED');
    const e = await bocha({ apiKey: 'ok', baseURL: s.url }).search(q, new AbortController().signal).catch((x) => x);
    assert.equal(e.code, 'UPSTREAM');
    assert.match(e.message, /余额不足/);
  } finally { await s.close(); }
});

test('博查：声明协议要求的 id 与名字', () => {
  const p = bocha({ apiKey: 'k' });
  assert.deepEqual([p.id, p.label], ['bocha', '博查']);
});
