import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { AdminStore, Currency, QuotaPolicy, SpendEntry, SpendQuery } from '@melon-ai/core';
import type { SqliteDriver } from './db.js';

/**
 * 后台的存储（额度策略、花费流水、站点设置）。单独一个库文件：
 * 它是宿主全局的（跨所有用户的引擎实例），不属于哪个实例的 `openSqliteStores`。
 */
const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS admin_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_policies (principal TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_spend (
  principal TEXT NOT NULL,
  at        INTEGER NOT NULL,
  amount    REAL NOT NULL,
  currency  TEXT NOT NULL,
  counted   INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  vendor    TEXT NOT NULL,
  model     TEXT NOT NULL,
  ok        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_spend_p_at ON admin_spend(principal, at);
CREATE INDEX IF NOT EXISTS idx_admin_spend_at ON admin_spend(at);
`;

type Row = { principal: string; at: number; amount: number; currency: string; counted: number; kind: string; vendor: string; model: string; ok: number };

export interface OpenAdminStoreOptions {
  /** 数据库文件路径，`:memory:` 用于测试。 */
  readonly file: string;
  /** 注入 `better-sqlite3`（原因见 `OpenOptions.driver`）。 */
  readonly driver?: SqliteDriver;
}

export class SqliteAdminStore implements AdminStore {
  readonly db: Db;

  constructor(opts: OpenAdminStoreOptions) {
    const Driver = opts.driver ?? (Database as unknown as SqliteDriver);
    this.db = new Driver(opts.file);
    this.db.exec(DDL);
  }

  async getSetting(key: string): Promise<unknown> {
    const r = this.db.prepare('SELECT v FROM admin_settings WHERE k = ?').get(key) as { v: string } | undefined;
    return r ? JSON.parse(r.v) : undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.db.prepare('DELETE FROM admin_settings WHERE k = ?').run(key); return; }
    this.db.prepare('INSERT INTO admin_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, JSON.stringify(value));
  }

  async getPolicy(principal: string): Promise<QuotaPolicy | null> {
    const r = this.db.prepare('SELECT body FROM admin_policies WHERE principal = ?').get(principal) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as QuotaPolicy) : null;
  }

  async setPolicy(principal: string, policy: QuotaPolicy | null): Promise<void> {
    if (!policy || policy.mode === 'default') { this.db.prepare('DELETE FROM admin_policies WHERE principal = ?').run(principal); return; }
    this.db.prepare('INSERT INTO admin_policies (principal, body) VALUES (?, ?) ON CONFLICT(principal) DO UPDATE SET body = excluded.body')
      .run(principal, JSON.stringify(policy));
  }

  async listPolicies(): Promise<Readonly<Record<string, QuotaPolicy>>> {
    const rows = this.db.prepare('SELECT principal, body FROM admin_policies').all() as { principal: string; body: string }[];
    return Object.fromEntries(rows.map((r) => [r.principal, JSON.parse(r.body) as QuotaPolicy]));
  }

  async recordSpend(e: SpendEntry): Promise<void> {
    this.db.prepare('INSERT INTO admin_spend (principal, at, amount, currency, counted, kind, vendor, model, ok) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(e.principal, e.at, e.amount, e.currency, e.counted ? 1 : 0, e.kind, e.vendor, e.model, e.ok ? 1 : 0);
  }

  async sumCounted(principal: string, from: number, to?: number): Promise<number> {
    const r = this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM admin_spend WHERE principal = ? AND counted = 1 AND at >= ? AND at < ?')
      .get(principal, from, to ?? Number.MAX_SAFE_INTEGER) as { s: number };
    return r.s;
  }

  async listSpend(q: SpendQuery): Promise<readonly SpendEntry[]> {
    const where = ['at >= ?', 'at < ?'];
    const args: unknown[] = [q.from, q.to ?? Number.MAX_SAFE_INTEGER];
    if (q.principal !== undefined) { where.push('principal = ?'); args.push(q.principal); }
    if (q.countedOnly) where.push('counted = 1');
    const rows = this.db.prepare(`SELECT * FROM admin_spend WHERE ${where.join(' AND ')} ORDER BY at`).all(...args) as Row[];
    return rows.map((r) => ({
      principal: r.principal, at: r.at, amount: r.amount, currency: r.currency as Currency, counted: r.counted === 1,
      kind: r.kind === 'tool' ? 'tool' : 'model', vendor: r.vendor, model: r.model, ok: r.ok === 1,
    }));
  }

  async purgeSpend(before: number): Promise<void> {
    this.db.prepare('DELETE FROM admin_spend WHERE at < ?').run(before);
  }

  close(): void { this.db.close(); }
}

export function openSqliteAdminStore(opts: OpenAdminStoreOptions): SqliteAdminStore {
  return new SqliteAdminStore(opts);
}
