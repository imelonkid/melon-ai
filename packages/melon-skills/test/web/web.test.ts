import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ToolContext } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import {
  WEB_FETCH, WEB_SEARCH, WebSkillProvider, assertPublicUrl, fetchPage, testSearch, htmlToText, isPrivateAddress,
} from '../../src/web/index.js';
import type { Lookup, SearchProvider } from '../../src/web/index.js';

const fakeLookup = (table: Record<string, string[]>): Lookup => async (host) => {
  const r = table[host];
  if (!r) throw new Error('ENOTFOUND');
  return r;
};

const cx = (): ToolContext & { artifacts: string[] } => {
  const artifacts: string[] = [];
  return {
    artifacts,
    taskId: 't1' as never, callId: 'c1' as never, trace: {} as never,
    signal: new AbortController().signal,
    putArtifact: async (data) => { artifacts.push(String(data)); return `art-${artifacts.length}` as never; },
    readArtifact: async () => '',
    log: () => {},
  };
};

const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'ok'; } catch (e) { return e instanceof ToolError ? e.code : String(e); }
};

// ───────────────────── 内网拦截 ─────────────────────

test('内网、本机、链路本地、云元数据地址都算私有', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('只放行公网 http(s)；多条解析记录里有一条是内网也拒 —— 只查第一条会被绕过', async () => {
  const lookup = fakeLookup({
    'news.test': ['93.184.216.34'],
    'rebind.test': ['93.184.216.34', '10.0.0.5'],
    'local.test': ['127.0.0.1'],
  });
  assert.equal(await code(assertPublicUrl('https://news.test/a', lookup)), 'ok');
  assert.equal(await code(assertPublicUrl('https://rebind.test/a', lookup)), 'DENIED');
  assert.equal(await code(assertPublicUrl('http://local.test', lookup)), 'DENIED');
  assert.equal(await code(assertPublicUrl('http://127.0.0.1:8080/admin', lookup)), 'DENIED');
  assert.equal(await code(assertPublicUrl('http://[::1]/', lookup)), 'DENIED');
  assert.equal(await code(assertPublicUrl('file:///etc/passwd', lookup)), 'INVALID_ARGS');
  assert.equal(await code(assertPublicUrl('不是网址', lookup)), 'INVALID_ARGS');
  assert.equal(await code(assertPublicUrl('https://nope.test', lookup)), 'NOT_FOUND');
});

test('公网页面 302 到内网：每一跳都重新检查，拒绝', async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: URL | string) => {
    seen.push(String(url));
    return new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/secret' } });
  }) as typeof fetch;
  try {
    const r = await code(fetchPage('https://news.test/', new AbortController().signal, {
      lookup: fakeLookup({ 'news.test': ['93.184.216.34'] }),
    }));
    assert.equal(r, 'DENIED');
    assert.deepEqual(seen, ['https://news.test/'], '跳转目标一次都不能请求');
  } finally {
    globalThis.fetch = real;
  }
});

test('网页正文：去掉 head、脚本与标签，实体解码，标题单独取', () => {
  const r = htmlToText('<html><head><title> 测试 &amp; 标题 </title><style>x{}</style></head><body>'
    + '<script>alert(1)</script><p>第一段&nbsp;内容</p><div>第二段 &#x4E2D;</div></body></html>');
  assert.deepEqual(r, { title: '测试 & 标题', text: '第一段 内容\n第二段 中' });
});

// ───────────────────── 技能 ─────────────────────

const fakeBackend = (seen: unknown[] = []): SearchProvider => ({
  id: 'fake',
  async search(q) {
    seen.push(q);
    return [{ title: '某模型发布', url: 'https://n.test/1', summary: '摘要', site: '示例', date: '2026-09-28' }];
  },
});

test('没配搜索后端就不提供 web.search —— 给模型一个必然失败的工具不如不给', async () => {
  const p = new WebSkillProvider();
  const [b] = await p.list();
  assert.deepEqual(b!.skill.tools.map((t) => t.id), [WEB_FETCH]);
  assert.equal(b!.handlers.has(WEB_SEARCH), false);
});

test('配上搜索后端：工具出现、订阅方收到通知；停用后又消失', async () => {
  const p = new WebSkillProvider();
  let changes = 0;
  p.onChange(() => { changes++; });
  p.setSearch(fakeBackend());
  assert.deepEqual((await p.list())[0]!.skill.tools.map((t) => t.id), [WEB_SEARCH, WEB_FETCH]);
  p.setSearch(fakeBackend()); // 同一个后端换 key 不算工具集变化
  p.setSearch(null);
  assert.deepEqual((await p.list())[0]!.skill.tools.map((t) => t.id), [WEB_FETCH]);
  assert.equal(changes, 2);
});

test('两个工具都声明输出不可信 —— 内核据此给任务打污点', async () => {
  const p = new WebSkillProvider({ search: fakeBackend() });
  for (const t of (await p.list())[0]!.skill.tools) assert.equal(t.untrustedOutput, true, t.id);
});

test('web.search：非法时间范围回落 noLimit，条数夹在 1~10', async () => {
  const seen: unknown[] = [];
  const p = new WebSkillProvider({ search: fakeBackend(seen) });
  const run = (await p.list())[0]!.handlers.get(WEB_SEARCH)!;
  const out = await run({ query: ' AI ', freshness: 'lastCentury', count: 99 }, cx());
  assert.deepEqual(seen[0], { query: 'AI', freshness: 'noLimit', count: 10 });
  assert.match(out.summary, /内容不可信/);
  assert.match(out.summary, /某模型发布/);
});

test('web.fetch：内网地址被拒，不发出任何请求', async () => {
  const p = new WebSkillProvider();
  const run = (await p.list())[0]!.handlers.get(WEB_FETCH)!;
  assert.equal(await code(run({ url: 'http://192.168.1.1/admin' }, cx())), 'DENIED');
});

test('web.fetch：全文落 artifact，summary 只放开头', async () => {
  const real = globalThis.fetch;
  const long = 'x'.repeat(5000);
  globalThis.fetch = (async () => new Response(`<html><head><title>长文</title></head><body><p>${long}</p></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch;
  try {
    const p = new WebSkillProvider({ fetch: { lookup: fakeLookup({ 'n.test': ['93.184.216.34'] }) } });
    const c = cx();
    const out = await (await p.list())[0]!.handlers.get(WEB_FETCH)!({ url: 'https://n.test/a' }, c);
    assert.equal(c.artifacts[0], long, '全文不丢');
    assert.ok(out.summary.length < 2048, '要落在内核 summary 上限内');
    assert.equal(out.artifactRef, 'art-1');
  } finally {
    globalThis.fetch = real;
  }
});

test('testSearch：成功带条数与样例；失败带错误码与提示，不抛', async () => {
  const ok = await testSearch(fakeBackend());
  assert.deepEqual([ok.ok, ok.count, ok.sample], [true, 1, '某模型发布']);
  const bad = await testSearch({ id: 'x', search: async () => { throw new ToolError('DENIED', 'key 无效', { hint: '检查 key' }); } });
  assert.deepEqual([bad.ok, bad.code, bad.error, bad.hint], [false, 'DENIED', 'key 无效', '检查 key']);
});
