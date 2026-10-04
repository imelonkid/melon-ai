import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryAdminStore } from '@melon-ai/store';
import { createAdmin } from '../src/index.js';

const make = () => createAdmin({ store: new InMemoryAdminStore(), principals: { list: () => [] } });

test('自带管理员账号：第一次启动给 admin + 一次性初始密码，只给一次；初始密码登录要先改；改完旧密码失效', async () => {
  const admin = make();
  const first = await admin.bootstrap();
  assert.equal(first?.username, 'admin');
  assert.match(first!.password, /^(?=.*[a-zA-Z])(?=.*\d).{12}$/);
  assert.equal(await admin.bootstrap(), null, '已经有了不再给');
  assert.deepEqual(await admin.auth.verify('admin', first!.password), { name: 'admin', mustChangePassword: true });
  assert.equal(await admin.auth.verify('admin', 'wrong'), null);
  assert.equal(await admin.auth.verify('nobody', first!.password), null);
  await assert.rejects(async () => admin.auth.changePassword!('admin', first!.password, 'short1'), /至少 8 位/);
  await assert.rejects(async () => admin.auth.changePassword!('admin', 'wrong', 'Better1234'), /原密码不对/);
  await admin.auth.changePassword!('admin', first!.password, 'Better1234');
  assert.deepEqual(await admin.auth.verify('admin', 'Better1234'), { name: 'admin' });
  assert.equal(await admin.auth.verify('admin', first!.password), null);
  // 忘了密码：重置成新的一次性初始密码，下次登录必须改
  const again = await admin.resetAdminPassword('admin');
  assert.deepEqual(await admin.auth.verify('admin', again), { name: 'admin', mustChangePassword: true });
  await assert.rejects(admin.resetAdminPassword('nobody'), /没有管理员/);
});

test('部署时给了用户名和密码（MELON_ADMIN_USER / MELON_ADMIN_PASSWORD）：用它们，当作自己定的不强制改；密码不合格拒绝', async () => {
  const a = make();
  assert.deepEqual(await a.bootstrap({ username: 'root', password: 'Chosen1234' }), { username: 'root', password: 'Chosen1234', generated: false });
  assert.deepEqual(await a.auth.verify('root', 'Chosen1234'), { name: 'root' });
  await assert.rejects(make().bootstrap({ password: 'weak' }), /不合格/);
  assert.equal((await make().settings()).siteName, 'melon-ai 管理后台');
});

test('宿主给了登录校验：bootstrap 不建账号', async () => {
  const admin = createAdmin({ store: new InMemoryAdminStore(), principals: { list: () => [] }, auth: { verify: () => null } });
  assert.equal(await admin.bootstrap(), null);
});

test('接口：初始密码登录后只能改密码（别的 403），改完就能用；其他会话作废', async () => {
  const admin = make();
  const { password } = (await admin.bootstrap())!;
  const handle = admin.handler('/admin');
  const server = createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/api/`;
  const session = () => {
    let cookie = '';
    return async (path: string, body?: unknown) => {
      const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return { status: r.status, json: await r.json() as any };
    };
  };
  try {
    const a = session();
    const other = session();
    assert.equal((await a('login', { username: 'admin', password })).json.me.mustChangePassword, true);
    await other('login', { username: 'admin', password });
    assert.equal((await a('meta')).json.me.mustChangePassword, true);
    const blocked = await a('users');
    assert.deepEqual([blocked.status, blocked.json.error.code], [403, 'must_change_password']);
    assert.equal((await a('password', { oldPassword: password, newPassword: 'abc' })).status, 400);
    assert.equal((await a('password', { oldPassword: password, newPassword: 'Better1234' })).status, 200);
    assert.equal((await a('users')).status, 200);
    assert.equal((await a('meta')).json.me.mustChangePassword, false);
    assert.equal((await other('users')).status, 401, '改密码后别的会话作废');
  } finally { server.close(); }
});
