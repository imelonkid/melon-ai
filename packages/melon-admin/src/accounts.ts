import type { AdminStore } from '@melon-ai/core';
import type { AdminAuth, AdminIdentity } from './types.js';

/**
 * 后台自带的管理员账号：给自己没有账号体系的宿主用（CLI、单用户的服务……）。
 * 存在后台存储的设置里；密码用 PBKDF2-SHA256（Web Crypto，任何运行时都有，不引 node:*）。
 * 第一次启动 `bootstrap` 建 `admin` + 随机初始密码，第一次登录必须改。
 */
interface Account {
  readonly username: string;
  readonly name: string;
  readonly salt: string;
  readonly hash: string;
  readonly iterations: number;
  readonly mustChangePassword: boolean;
}

const KEY = 'admin.accounts';
const ITERATIONS = 210_000;
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations }, key, 256);
  return hex(bits);
}

/** 定长比较，不因为前几位就提前返回。 */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** 新密码的最低要求；合格返回 null。 */
export function weakAdminPassword(pw: string): string | null {
  if (pw.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return '密码要同时有字母和数字';
  return null;
}

/** 一次性初始密码：12 位，去掉容易看错的字符，保证有字母和数字。 */
export function initialAdminPassword(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  while (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) {
    const b = new Uint8Array(12);
    globalThis.crypto.getRandomValues(b);
    s = Array.from(b, (x) => abc[x % abc.length]).join('');
  }
  return s;
}

export class BuiltinAdminAuth implements AdminAuth {
  constructor(private readonly store: AdminStore) {}

  private async accounts(): Promise<Account[]> {
    return ((await this.store.getSetting(KEY)) as Account[] | undefined) ?? [];
  }

  private async make(username: string, password: string, mustChangePassword: boolean, name = username): Promise<Account> {
    const salt = new Uint8Array(16);
    globalThis.crypto.getRandomValues(salt);
    return { username, name, salt: hex(salt), hash: await derive(password, salt, ITERATIONS), iterations: ITERATIONS, mustChangePassword };
  }

  async bootstrap(username: string, given?: string): Promise<{ username: string; password: string; generated: boolean } | null> {
    if ((await this.accounts()).length) return null;
    if (given !== undefined) { const weak = weakAdminPassword(given); if (weak) throw new Error(`管理员密码不合格：${weak}`); }
    const password = given ?? initialAdminPassword();
    await this.store.setSetting(KEY, [await this.make(username, password, given === undefined)]);
    return { username, password, generated: given === undefined };
  }

  async reset(username: string): Promise<string> {
    const list = await this.accounts();
    const i = list.findIndex((x) => x.username.toLowerCase() === username.toLowerCase());
    if (i < 0) throw new Error(`没有管理员「${username}」`);
    const password = initialAdminPassword();
    list[i] = await this.make(list[i]!.username, password, true, list[i]!.name);
    await this.store.setSetting(KEY, list);
    return password;
  }

  async verify(username: string, password: string): Promise<AdminIdentity | null> {
    const a = (await this.accounts()).find((x) => x.username.toLowerCase() === username.toLowerCase());
    // 用户不存在也算一次：别让响应时间暴露「有没有这个人」
    const got = await derive(password, a ? unhex(a.salt) : new Uint8Array(16), a?.iterations ?? ITERATIONS);
    if (!a || !same(got, a.hash)) return null;
    return { name: a.name, ...(a.mustChangePassword ? { mustChangePassword: true } : {}) };
  }

  async changePassword(username: string, oldPassword: string, newPassword: string): Promise<void> {
    const list = await this.accounts();
    const i = list.findIndex((x) => x.username.toLowerCase() === username.toLowerCase());
    if (i < 0 || !(await this.verify(username, oldPassword))) throw new Error('原密码不对');
    const weak = weakAdminPassword(newPassword);
    if (weak) throw new Error(weak);
    if (oldPassword === newPassword) throw new Error('新密码不能和原密码一样');
    const cur = list[i]!;
    list[i] = await this.make(cur.username, newPassword, false, cur.name);
    await this.store.setSetting(KEY, list);
  }
}
