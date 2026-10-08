import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryAdminStore } from '@melon-ai/store';
import { createAdmin } from '../src/index.js';
import type { ResourceSection } from '../src/index.js';

const SECTIONS: ResourceSection[] = [
  { kind: 'model', title: '模型', vendors: [
    { id: 'ds', label: 'DS', fields: [{ key: 'apiKey', label: 'API key', secret: true }, { key: 'baseURL', label: '地址', optional: true }] },
    { id: 'zp', label: 'ZP', fields: [{ key: 'apiKey', label: 'API key', secret: true }] },
  ] },
  { kind: 'search', title: '搜索', multiple: false, vendors: [
    { id: 'a', label: 'A', fields: [{ key: 'apiKey', label: 'key', secret: true }] },
    { id: 'b', label: 'B', fields: [{ key: 'apiKey', label: 'key', secret: true }] },
  ] },
];
const make = (store = new InMemoryAdminStore()) => createAdmin({
  store, principals: { list: () => [] }, resources: SECTIONS,
  testResource: async (_k, _v, values) => ({ ok: values['apiKey'] === 'sk-good-1234567890', message: values['apiKey'] === 'sk-good-1234567890' ? '连通' : 'key 不对' }),
  routing: { classes: [{ id: 'chat', label: '对话' }, { id: 'sched', label: '定时' }], options: () => [{ key: 'shared:ds/flash', label: 'DS flash' }] },
});

test('共享资源：页面只看到打码；回传 __KEEP__ 或打码原样不改；启用前必填项不能空；宿主拿到明文', async () => {
  const admin = make();
  const sh = admin.shared!;
  await assert.rejects(sh.set('model', 'ds', { enabled: true, values: {} }), /启用前要填：API key/);
  await sh.set('model', 'ds', { enabled: true, values: { apiKey: 'sk-secret-1234567890', baseURL: '' } });
  const v = await sh.view();
  assert.equal(v['model']!['ds']!.values['apiKey'], 'sk-s••••••••7890');
  assert.equal(v['model']!['ds']!.filled['apiKey'], true);
  await sh.set('model', 'ds', { values: { apiKey: '__KEEP__', baseURL: 'https://proxy' } });
  await sh.set('model', 'ds', { values: { apiKey: 'sk-s••••••••7890' } });
  const cfg = await sh.configs();
  assert.deepEqual(cfg['model']!['ds'], { enabled: true, values: { apiKey: 'sk-secret-1234567890', baseURL: 'https://proxy' } });
});

test('只能启用一家的那类：启用这家就停用别家；测试用存着的密钥（页面没改的）', async () => {
  const admin = make();
  const sh = admin.shared!;
  await sh.set('search', 'a', { enabled: true, values: { apiKey: 'sk-good-1234567890' } });
  await sh.set('search', 'b', { enabled: true, values: { apiKey: 'kb' } });
  const cfg = await sh.configs();
  assert.deepEqual([cfg['search']!['a']!.enabled, cfg['search']!['b']!.enabled], [false, true]);
  assert.deepEqual(await sh.runTest('search', 'a', { apiKey: '__KEEP__' }), { ok: true, message: '连通' });
});

test('watch：同一个进程里改了立即回调；另一个进程（另一个 Admin 实例、同一个库）改了轮询发现', async () => {
  const store = new InMemoryAdminStore();
  const a = make(store);
  const b = make(store);
  let hits = 0;
  const off = a.shared!.watch(() => { hits++; }, 20);
  await new Promise((r) => setTimeout(r, 30));
  await a.shared!.set('model', 'zp', { enabled: true, values: { apiKey: 'k1' } });
  assert.equal(hits, 1);
  await b.shared!.setRoutingRules({ chat: { minTier: 'strong' } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hits, 2, '别的实例改的也发现了');
  off();
});

test('路由规则：只留宿主描述过的类别和认识的档次', async () => {
  const sh = make().shared!;
  const saved = await sh.setRoutingRules({ chat: { minTier: 'strong', pin: ' shared:ds/flash ' }, sched: { minTier: 'nope' }, other: { minTier: 'basic' } });
  assert.deepEqual(saved, { chat: { minTier: 'strong', pin: 'shared:ds/flash' } });
  assert.deepEqual(await sh.routingRules(), saved);
});

test('接口：共享资源 / 路由规则 / 新建用户 / 重置密码（宿主提供了才有）；页面拿不到明文', async () => {
  const created: string[] = [];
  const admin = createAdmin({
    store: new InMemoryAdminStore(), resources: SECTIONS, routing: { classes: [{ id: 'chat', label: '对话' }] },
    principals: {
      list: () => [{ id: 'u1', name: '小林' }],
      create: ({ username }) => { created.push(username); return { id: 'u2', initialPassword: 'Init1234abcd' }; },
      resetPassword: (id) => `Reset-${id}-99`,
    },
  });
  const boot = (await admin.bootstrap({ password: 'Admin1234x' }))!;
  const handle = admin.handler('/admin');
  const server = createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/api/`;
  let cookie = '';
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!;
    return { status: r.status, json: await r.json() as any };
  };
  try {
    await call('login', { username: boot.username, password: 'Admin1234x' });
    const meta = (await call('meta')).json;
    assert.deepEqual([meta.canCreateUser, meta.canResetPassword, meta.hasResources, meta.hasRouting], [true, true, true, true]);
    await call('resources', { kind: 'model', vendor: 'ds', enabled: true, values: { apiKey: 'sk-secret-1234567890' } });
    const view = await call('resources');
    assert.ok(!JSON.stringify(view.json).includes('sk-secret-1234567890'), '页面拿不到明文');
    assert.equal(view.json.sections.length, 2);
    assert.equal((await call('resources', { kind: 'model', vendor: 'zp', enabled: true, values: {} })).status, 400);
    assert.deepEqual((await call('routing', { rules: { chat: { minTier: 'standard' } } })).json.rules, { chat: { minTier: 'standard' } });
    assert.deepEqual((await call('routing')).json.tiers.map((t: { id: string }) => t.id), ['basic', 'standard', 'strong']);
    const c = await call('users', { username: 'xiaomei', name: '小美' });
    assert.deepEqual([c.json.initialPassword, created], ['Init1234abcd', ['xiaomei']]);
    assert.equal((await call('users/u1/reset', {})).json.initialPassword, 'Reset-u1-99');
  } finally { server.close(); }
});

test('宿主没配共享资源：接口 404，页面不显示那两页', async () => {
  const admin = createAdmin({ store: new InMemoryAdminStore(), principals: { list: () => [] } });
  assert.equal(admin.shared, null);
});
