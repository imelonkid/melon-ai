import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext, ToolHandler } from '@melon-ai/core';
import { mcp, parseMcpServers } from '../../src/mcp/index.js';

const FIXTURE = fileURLToPath(new URL('./fixture-server.mjs', import.meta.url));
const cx = (): ToolContext => ({
  taskId: 't' as never, callId: 'c' as never, trace: {} as never, signal: new AbortController().signal,
  putArtifact: async () => 'a' as never, readArtifact: async () => '', log: () => {},
});
const stdio = (extra: Record<string, unknown> = {}) => ({ name: 'Fixture Server', transport: { kind: 'stdio' as const, command: process.execPath, args: [FIXTURE] }, sandbox: false, ...extra });

test('MCP：连上后列出工具 —— id 规整成「服务器.工具」；都按对外操作（不采信只读标注）、输出不可信；标了有破坏性的按不可撤销；说明里有注入的不注册', async () => {
  const p = mcp(stdio());
  try {
    const st = await p.ready();
    assert.equal(st.state, 'ready', st.error);
    assert.equal(st.skillId, 'fixture_server');
    assert.deepEqual(st.server, { name: 'fixture', version: '1.2.3' });
    assert.match(st.log, /fixture server started/, '服务器的输出留着排查');
    const view = (n: string) => st.tools.find((t) => t.name === n)!;
    assert.equal(view('getWeather').id, 'fixture_server.getweather');
    assert.equal(view('getWeather').risk, 'external', '自称只读也不采信');
    assert.equal(view('delete_repo').risk, 'irreversible');
    assert.equal(view('delete_repo').destructive, true);
    assert.ok(view('evil').rejected?.some((r) => /忽略之前的指令/.test(r)), '工具投毒：不注册，原因给用户看');

    const [b] = await p.list();
    const ids = b!.skill.tools.map((t) => String(t.id));
    assert.ok(ids.includes('fixture_server.getweather') && !ids.includes('fixture_server.evil'));
    const d = b!.skill.tools.find((t) => t.id === 'fixture_server.getweather')!;
    assert.equal(d.untrustedOutput, true);
    assert.deepEqual(d.triggers, []);
    assert.match(d.description, /^查天气：查某个城市的天气/);
    assert.equal(b!.skill.source.kind, 'extension');
  } finally { await p.close(); }
});

test('MCP：调用 —— 文字进摘要、结构化结果进 data；图片注明看不了；出错的抛给模型；服务器加了工具会通知', async () => {
  const p = mcp(stdio());
  try {
    await p.ready();
    let changed = 0;
    p.onChange(() => { changed += 1; });
    const [b] = await p.list();
    const run = (id: string, args: unknown) => (b!.handlers.get(`fixture_server.${id}`) as ToolHandler)(args, cx());
    const w = await run('getweather', { city: '杭州' });
    assert.equal(w.summary, '杭州：晴，22 度');
    assert.deepEqual(w.data, { city: '杭州', temp: 22 });
    assert.match((await run('chart', {})).summary, /图在这里\n（返回了一张图片，image\/png，看不了）/);
    await assert.rejects(run('fail', {}), /上游服务挂了/);

    await run('add_tool', {});
    for (let i = 0; i < 40 && !p.status().tools.some((t) => t.name === 'new_tool'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(p.status().tools.some((t) => t.name === 'new_tool'), '工具列表变了：重新列出');
    assert.ok(changed >= 1, '通知注册表刷新');
  } finally { await p.close(); }
});

test('MCP：没启用的服务器照样连接、列出工具给用户过目，但不提供给 Agent；连不上的说清楚原因', async () => {
  const off = mcp(stdio({ enabled: false }));
  try {
    const st = await off.ready();
    assert.equal(st.state, 'ready');
    assert.equal(st.enabled, false);
    assert.ok(st.tools.length > 0);
    assert.deepEqual(await off.list(), []);
    let changed = 0;
    off.onChange(() => { changed += 1; });
    off.setEnabled(true);
    assert.equal(changed, 1, '启用不用重连，通知注册表');
    assert.ok((await off.list()).length === 1);
  } finally { await off.close(); }

  const bad = mcp({ name: 'nope', transport: { kind: 'stdio', command: '/no/such/command' }, sandbox: false }, { connectTimeoutMs: 5000 });
  try {
    const st = await bad.ready();
    assert.equal(st.state, 'error');
    assert.match(st.error!, /找不到命令 \/no\/such\/command|ENOENT/);
    assert.deepEqual(await bad.list(), []);
    assert.equal((await bad.health()).status, 'down');
  } finally { await bad.close(); }
});

test('MCP：本机命令跑在沙箱里 —— 宿主的数据目录、密钥不能读；临时目录可以', { skip: process.platform !== 'darwin' }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-sb-')));
  try {
    mkdirSync(join(dir, 'appdata'));
    writeFileSync(join(dir, 'appdata', 'models.json'), '{"apiKey":"sk-secret"}');
    writeFileSync(join(dir, 'ok.txt'), '可以读');
    const p = mcp({ name: 'fs', transport: { kind: 'stdio', command: process.execPath, args: [FIXTURE] } }, { denyRead: [join(dir, 'appdata')] });
    try {
      const st = await p.ready();
      assert.equal(st.state, 'ready', `${st.error}\n${st.log}`);
      assert.deepEqual(st.sandbox, { kind: 'seatbelt' });
      const [b] = await p.list();
      const read = b!.handlers.get('fs.read_file') as ToolHandler;
      assert.equal((await read({ path: join(dir, 'ok.txt') }, cx())).summary, '可以读');
      await assert.rejects(read({ path: join(dir, 'appdata', 'models.json') }, cx()), /operation not permitted|EPERM/i);
    } finally { await p.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP：远程地址（Streamable HTTP）带上请求头里的 key；key 不对说清楚', async () => {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer good') { res.writeHead(401).end('unauthorized'); return; }
    const server = new Server({ name: 'remote', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ping', description: '测连通', inputSchema: { type: 'object', properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    // 无会话模式。SDK 的类型在 exactOptionalPropertyTypes 下对不上，运行时没问题
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    res.on('close', () => { void t.close(); void server.close(); });
    await server.connect(t as never);
    let body = '';
    for await (const c of req) body += c;
    await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  try {
    const p = mcp({ name: 'remote', transport: { kind: 'http', url, headers: { Authorization: 'Bearer good' } } });
    try {
      const st = await p.ready(10_000);
      assert.equal(st.state, 'ready', st.error);
      assert.equal(st.sandbox, null, '远程的不用沙箱');
      const [b] = await p.list();
      assert.equal((await (b!.handlers.get('remote.ping') as ToolHandler)({}, cx())).summary, 'pong');
    } finally { await p.close(); }
    const bad = mcp({ name: 'remote', transport: { kind: 'http', url, headers: { Authorization: 'Bearer bad' } } }, { connectTimeoutMs: 5000 });
    try {
      const st = await bad.ready(10_000);
      assert.equal(st.state, 'error');
      assert.match(st.error!, /key 不对或没有权限|401/);
    } finally { await bad.close(); }
  } finally { http.close(); }
});

test('MCP：解析常见的 mcpServers 配置（本机命令 / 远程地址），认不出的说清楚', () => {
  const r = parseMcpServers(JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
    remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer y' } },
    broken: { foo: 1 },
  } }));
  assert.deepEqual(r.servers.map((s) => [s.name, s.transport.kind]), [['github', 'stdio'], ['remote', 'http']]);
  assert.deepEqual(r.servers[0]!.transport, { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } });
  assert.match(r.errors[0]!, /broken/);
  assert.match(parseMcpServers('{').errors[0]!, /不是合法的 JSON/);
  assert.equal(parseMcpServers(JSON.stringify({ x: { command: 'uvx', args: ['mcp-server-time'] } })).servers[0]!.name, 'x', '不带外层 mcpServers 也认');
});
