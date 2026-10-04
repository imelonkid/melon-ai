import type { AdminApi } from './types.js';
import { ADMIN_HTML } from './ui.js';

/**
 * 后台的接口与页面，宿主挂到自己的 HTTP 服务上（Node 的 `http` 或兼容的 req / res）。
 * 不引 node:* —— 只用请求对象上的东西和全局的 crypto。
 *
 * 安全：
 * - 会话令牌放 HttpOnly、SameSite=Strict 的 cookie（路径限定在后台下），只存在内存里：服务重启要重新登录。
 * - 写操作只收 `application/json`（跨站表单发不出来），再加上 SameSite，挡住跨站请求伪造。
 * - 登录失败按用户名限速：10 分钟内错 5 次就先拒绝。
 */

export interface AdminRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  on(event: 'data', cb: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (e: unknown) => void): unknown;
}
export interface AdminResponse {
  writeHead(status: number, headers?: Record<string, string | string[]>): unknown;
  end(body?: string): unknown;
}

const SESSION_MS = 12 * 3_600_000;
const COOKIE = 'melon_admin';

class HttpErr extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const header = (req: AdminRequest, name: string): string => {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

function token(): string {
  const b = new Uint8Array(24);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function readJson(req: AdminRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: string[] = [];
    const dec = new TextDecoder();
    req.on('data', (c) => {
      size += typeof c === 'string' ? c.length : c.byteLength;
      if (size > 65_536) { reject(new HttpErr(413, 'too_large', '请求太大')); return; }
      parts.push(typeof c === 'string' ? c : dec.decode(c, { stream: true }));
    });
    req.on('end', () => {
      const s = parts.join('');
      if (!s) { resolve({}); return; }
      try { const v = JSON.parse(s); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}); }
      catch { reject(new HttpErr(400, 'bad_json', '请求不是 JSON')); }
    });
    req.on('error', reject);
  });
}

export interface AdminHandlerOptions {
  /** 挂在哪个路径下，比如 `/admin`。 */
  readonly basePath: string;
  readonly now?: () => number;
}

/** 返回一个处理函数：是后台的请求就处理并返回 true，不是返回 false（交给宿主的其他路由）。 */
export function adminHandler(admin: AdminApi, o: AdminHandlerOptions): (req: AdminRequest, res: AdminResponse) => boolean {
  const base = o.basePath.replace(/\/+$/, '');
  const now = o.now ?? Date.now;
  const sessions = new Map<string, { name: string; exp: number }>();
  const fails = new Map<string, { n: number; until: number }>();

  const send = (res: AdminResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  const cookieOf = (req: AdminRequest) => {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{48})`).exec(header(req, 'cookie'));
    return m?.[1] ?? null;
  };
  const who = (req: AdminRequest) => {
    const t = cookieOf(req);
    const s = t ? sessions.get(t) : undefined;
    if (!t || !s) return null;
    if (s.exp < now()) { sessions.delete(t); return null; }
    s.exp = now() + SESSION_MS; // 用着就续
    return s;
  };
  const cookie = (req: AdminRequest, value: string, maxAge: number) => {
    const secure = header(req, 'x-forwarded-proto') === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  };

  async function route(req: AdminRequest, res: AdminResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (method === 'POST' && !header(req, 'content-type').startsWith('application/json')) throw new HttpErr(415, 'json_only', '只收 JSON');

    if (path === '/api/meta' && method === 'GET') {
      const me = who(req);
      return send(res, 200, { ok: true, site: await admin.settings(), me: me ? { name: me.name } : null, canSetStatus: !!admin.principals.setStatus, windows: admin.quota.windows, symbol: admin.symbol });
    }
    if (path === '/api/login' && method === 'POST') {
      const b = await readJson(req);
      const username = String(b['username'] ?? '').trim();
      const password = String(b['password'] ?? '');
      const f = fails.get(username.toLowerCase());
      if (f && f.n >= 5 && f.until > now()) throw new HttpErr(429, 'throttled', '错的次数太多了，过几分钟再试');
      const ok = username && password ? await admin.auth.verify(username, password) : null;
      if (!ok) {
        const cur = f && f.until > now() ? f : { n: 0, until: now() + 600_000 };
        fails.set(username.toLowerCase(), { n: cur.n + 1, until: cur.until });
        throw new HttpErr(401, 'bad_credentials', '用户名或密码不对，或者不是管理员');
      }
      fails.delete(username.toLowerCase());
      const t = token();
      sessions.set(t, { name: ok.name, exp: now() + SESSION_MS });
      return send(res, 200, { ok: true, me: { name: ok.name } }, { 'set-cookie': cookie(req, t, SESSION_MS / 1000) });
    }
    if (path === '/api/logout' && method === 'POST') {
      const t = cookieOf(req);
      if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, '', 0) });
    }

    // 以下都要登录
    if (!who(req)) throw new HttpErr(401, 'unauthorized', '请先登录');

    if (path === '/api/overview' && method === 'GET') return send(res, 200, { ok: true, overview: await admin.overview() });
    if (path === '/api/users' && method === 'GET') return send(res, 200, { ok: true, users: await admin.users() });
    const daily = /^\/api\/users\/([^/]+)\/daily$/.exec(path);
    if (daily && method === 'GET') {
      const days = Math.min(90, Math.max(1, Number(new URL(req.url ?? '/', 'http://x').searchParams.get('days')) || 30));
      return send(res, 200, { ok: true, days: await admin.daily(days, decodeURIComponent(daily[1]!)) });
    }
    const quota = /^\/api\/users\/([^/]+)\/quota$/.exec(path);
    if (quota && method === 'POST') {
      const b = await readJson(req);
      const mode = b['mode'] === 'custom' || b['mode'] === 'unlimited' ? b['mode'] : 'default';
      const amounts = b['amounts'] && typeof b['amounts'] === 'object' ? b['amounts'] as Record<string, number> : undefined;
      const id = decodeURIComponent(quota[1]!);
      const policy = await admin.quota.setPolicy(id, { mode, ...(amounts ? { amounts } : {}) });
      return send(res, 200, { ok: true, policy, quota: await admin.status(id) });
    }
    const status = /^\/api\/users\/([^/]+)\/status$/.exec(path);
    if (status && method === 'POST') {
      if (!admin.principals.setStatus) throw new HttpErr(404, 'unsupported', '这个服务不支持在后台停用用户');
      const b = await readJson(req);
      await admin.principals.setStatus(decodeURIComponent(status[1]!), b['status'] === 'disabled' ? 'disabled' : 'active');
      return send(res, 200, { ok: true });
    }
    if (path === '/api/policy' && method === 'GET') return send(res, 200, { ok: true, amounts: await admin.quota.defaultAmounts() });
    if (path === '/api/policy' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, { ok: true, amounts: await admin.quota.setDefaultAmounts((b['amounts'] ?? {}) as Record<string, number>) });
    }
    if (path === '/api/settings' && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, { ok: true, site: await admin.setSettings(b as never) });
    }
    throw new HttpErr(404, 'not_found', '没有这个接口');
  }

  return (req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0]!;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    // 页面里用相对路径调接口：没带结尾斜杠先补上
    if (path === base) { res.writeHead(301, { location: `${base}/` }); res.end(); return true; }
    const rest = path.slice(base.length);
    if (rest === '/' && (req.method ?? 'GET') === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        // 页面只跑自己内联的脚本、只连自己
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
      });
      res.end(ADMIN_HTML);
      return true;
    }
    route(req, res, rest).catch((e: unknown) => {
      if (e instanceof HttpErr) send(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
      else send(res, 500, { ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } });
    });
    return true;
  };
}
