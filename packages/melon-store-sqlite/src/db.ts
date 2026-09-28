import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT,
  root_id    TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  goal       TEXT NOT NULL,
  state      TEXT NOT NULL,
  deadline   INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version    INTEGER NOT NULL,
  -- 其余字段整体存 JSON：它们只被整体读写，拆成列除了迁移负担没有好处
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state    ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(state, deadline);

CREATE TABLE IF NOT EXISTS task_events (
  task_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE IF NOT EXISTS episodes (
  id        TEXT PRIMARY KEY,
  root_id   TEXT NOT NULL,
  state     TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  summary   TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_root ON episodes(root_id);

CREATE TABLE IF NOT EXISTS entries (
  episode_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (episode_id, seq)
);

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  agent_id    TEXT,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  statement   TEXT NOT NULL,
  confidence  REAL NOT NULL,
  importance  REAL NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  use_count   INTEGER NOT NULL,
  supersedes  TEXT,
  ttl         INTEGER,
  task_id     TEXT NOT NULL,
  event_seq   INTEGER NOT NULL,
  -- 被 supersede 后退出召回，但不物理删（§2.5 supersede 动因）
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_subject ON memories(scope, subject, kind);
CREATE INDEX IF NOT EXISTS idx_mem_task    ON memories(task_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  statement, subject, content='memories', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS vectors (
  id   TEXT PRIMARY KEY,
  dims INTEGER NOT NULL,
  vec  BLOB NOT NULL,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  ref        TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  path       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_art_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS grants (
  agent_id   TEXT NOT NULL,
  tool_id    TEXT NOT NULL,
  scope      TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (agent_id, tool_id, scope)
);

CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  res_kind   TEXT NOT NULL,
  res_ref    TEXT NOT NULL,
  res_hash   TEXT,
  outcome    TEXT NOT NULL,
  trace_id   TEXT NOT NULL,
  span_id    TEXT,
  task_id    TEXT,
  dimensions TEXT,
  basis      TEXT,
  prev_hash  TEXT,
  hash       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit(actor_kind, actor_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, at);
CREATE INDEX IF NOT EXISTS idx_audit_trace  ON audit(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_res    ON audit(res_kind, res_ref);

CREATE TABLE IF NOT EXISTS tombstones (
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

CREATE TABLE IF NOT EXISTS idempotency (
  key        TEXT PRIMARY KEY,
  result     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive (
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  payload    TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);
`;

/**
 * 全局写锁。
 *
 * ── 为什么必须有 ──
 * `better-sqlite3` 的 `db.transaction(fn)` **只支持同步 fn**，
 * 而我们的存储端口全是 async（`StoreBundle.transaction<T>(fn: () => Promise<T>)`）。
 *
 * 于是只能手写 `BEGIN IMMEDIATE` / `COMMIT`。但 `await` 会让出事件循环 ——
 * 另一个任务的 `apply()` 可能在事务中间插进来执行 `BEGIN`，
 * 造成嵌套事务错误，或者更糟：它的写入被卷进别人的事务里一起回滚。
 *
 * 单机单用户、活跃任务 O(10)（假设 A3），一把全局写锁完全够用，
 * 比任何精细方案都可靠。要撑更高并发就该换 Postgres，那时这个类整体消失。
 */
class WriteLock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface OpenOptions {
  /** 数据库文件路径，`:memory:` 用于测试。 */
  readonly file: string;
  /** artifact 负载的落盘目录。默认取数据库同级的 `artifacts/`。 */
  readonly artifactDir?: string;
  readonly readonly?: boolean;
}

export class SqliteContext {
  readonly db: Db;
  readonly artifactDir: string;
  private readonly lock = new WriteLock();

  constructor(opts: OpenOptions) {
    this.db = new Database(opts.file, opts.readonly ? { readonly: true } : {});
    this.db.exec(DDL);
    const cur = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as { v: string } | undefined;
    if (!cur) {
      this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    } else if (Number(cur.v) !== SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${cur.v} 与代码期望的 ${SCHEMA_VERSION} 不符，需要迁移`,
      );
    }
    this.artifactDir = opts.artifactDir ?? defaultArtifactDir(opts.file);
  }

  /** 见 WriteLock 的说明：手写事务 + 全局写锁。 */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn();
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* 已经回滚了 */ }
        throw e;
      }
    });
  }

  close(): void {
    this.db.close();
  }
}

function defaultArtifactDir(file: string): string {
  if (file === ':memory:') {
    return `${process.env['TMPDIR'] ?? '/tmp'}/melon-artifacts-${process.pid}`;
  }
  const i = file.lastIndexOf('/');
  return `${i < 0 ? '.' : file.slice(0, i)}/artifacts`;
}

export const json = <T>(v: T): string => JSON.stringify(v);
export const unjson = <T>(s: string): T => JSON.parse(s) as T;
