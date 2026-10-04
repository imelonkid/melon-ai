import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryAdminStore } from '@melon-ai/store';
import { createAdmin } from '../src/index.js';

async function serve() {
  const admin = createAdmin({
    store: new InMemoryAdminStore(),
    principals: { list: () => [{ id: 'u1', name: '小林' }, { id: 'u/2', name: 'bob' }] },
    auth: { verify: (u, p) => (u === 'lin' && p === 'pw-1234567' ? { name: '小林' } : null) },
  });
  const handle = admin.handler('/admin');
  const server = createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end('host'); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 页面 */ }
    return { status: r.status, json, text, headers: r.headers, setCookie: set };
  };
  return { server, call, admin };
}

test('后台接口：不是后台的路径交还宿主；/admin 补斜杠；页面带 CSP；没登录 401', async () => {
  const { server, call } = await serve();
  try {
    assert.equal((await call('/other')).text, 'host');
    const r = await call('/admin');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/admin/');
    const page = await call('/admin/');
    assert.match(page.text, /<title>/);
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    assert.equal((await call('/admin/api/users')).status, 401);
    assert.equal((await call('/admin/api/meta')).json.me, null);
  } finally { server.close(); }
});

test('登录：密码不对 401，连错 5 次限速；登录后 cookie 是 HttpOnly + SameSite=Strict、限在后台路径；退出后失效', async () => {
  const { server, call } = await serve();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await call('/admin/api/login', { username: 'lin', password: 'wrong' })).status, 401);
    assert.equal((await call('/admin/api/login', { username: 'lin', password: 'pw-1234567' })).status, 429, '错满 5 次先拒绝，密码对了也不行');
  } finally { server.close(); }
  const s2 = await serve();
  try {
    const ok = await s2.call('/admin/api/login', { username: 'lin', password: 'pw-1234567' });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookie ?? '', /HttpOnly/);
    assert.match(ok.setCookie ?? '', /SameSite=Strict/);
    assert.match(ok.setCookie ?? '', /Path=\/admin\//);
    assert.equal((await s2.call('/admin/api/meta')).json.me.name, '小林');
    assert.equal((await s2.call('/admin/api/users')).json.users.length, 2);
    await s2.call('/admin/api/logout', {});
    assert.equal((await s2.call('/admin/api/users')).status, 401);
  } finally { s2.server.close(); }
});

test('写操作只收 JSON（跨站表单发不出来）；改额度、通用策略、站点设置；用户 id 带斜杠也行；不支持停用时 404', async () => {
  const { server, call } = await serve();
  try {
    await call('/admin/api/login', { username: 'lin', password: 'pw-1234567' });
    const form = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/api/policy`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'amounts=1',
    });
    assert.equal(form.status, 415);
    const q = await call(`/admin/api/users/${encodeURIComponent('u/2')}/quota`, { mode: 'custom', amounts: { day: 9, '5h': 3 } });
    assert.deepEqual(q.json.policy, { mode: 'custom', amounts: { day: 9, '5h': 3 } });
    assert.equal(q.json.quota.windows[0].limit, 9);
    assert.deepEqual((await call('/admin/api/policy', { amounts: { day: 4 } })).json.amounts, { day: 4, '5h': 0.8 });
    assert.equal((await call('/admin/api/settings', { siteName: '运营后台' })).json.site.siteName, '运营后台');
    assert.equal((await call('/admin/api/meta')).json.site.siteName, '运营后台');
    assert.equal((await call('/admin/api/users/u1/status', { status: 'disabled' })).status, 404);
    const daily = await call('/admin/api/users/u1/daily?days=7');
    assert.equal(daily.json.days.length, 7);
  } finally { server.close(); }
});
