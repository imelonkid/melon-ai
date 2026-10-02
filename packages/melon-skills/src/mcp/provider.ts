import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  Health, JSONSchema, RiskClass, Sandbox, SandboxPolicy, Skill, SkillBundle, SkillProvider, ToolDescriptor, ToolHandler, ToolOutput,
} from '@melon-ai/core';
import { SENSITIVE_HOME_PATHS, ToolError, asSkillId, asToolId } from '@melon-ai/core';
import { detectSandbox } from '../agentskills/sandbox.js';
import { reviewTool } from '../registry/review.js';

/** 一个 MCP 服务器怎么连。 */
export type McpTransportConfig =
  /** 本机命令（stdio），如 `npx -y @modelcontextprotocol/server-filesystem ~/Documents`。 */
  | { readonly kind: 'stdio'; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string }
  /** 远程地址（Streamable HTTP，连不上再试旧的 SSE）。key 放在请求头里。 */
  | { readonly kind: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>> };

export interface McpServerConfig {
  /** 服务器的名字（用户起的）。工具 id 的前缀由它规整而来：`github` → `github.create_issue`。 */
  readonly name: string;
  readonly transport: McpTransportConfig;
  /**
   * 是否把工具提供给 Agent。默认 true。`false` 时照样连接、列出工具（给用户看过再启用 —— 防工具投毒），但 Agent 拿不到。
   */
  readonly enabled?: boolean;
  /** 本机命令跑在沙箱里（默认 true）。有的服务器要读写受保护的位置，用户可以单独关。 */
  readonly sandbox?: boolean;
}

export interface McpOptions {
  /** 宿主自己存 key、存数据的目录：沙箱里的服务器不能读写（和密钥、钥匙串一样）。 */
  readonly denyRead?: readonly string[];
  /** 沙箱实现。不给：用当前平台的（macOS 是 Seatbelt；没有时照常跑，`status().sandbox` 为 null）。`false`：不用。 */
  readonly sandbox?: Sandbox | false;
  /** 给本机命令的基础环境变量（宿主从登录 shell 取的 PATH 之类）。服务器自己的 `env` 优先。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 一次工具调用最多等多久，默认 60 秒。 */
  readonly callTimeoutMs?: number;
  /** 连接（含启动进程、握手、列工具）最多等多久，默认 60 秒（第一次 `npx` 要下载）。 */
  readonly connectTimeoutMs?: number;
  /** 告诉服务器自己是谁。 */
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

export type McpState = 'connecting' | 'ready' | 'error' | 'closed';

/** 给宿主界面看的一个工具。 */
export interface McpToolView {
  /** 注册用的 id（`github.create_issue`）。 */
  readonly id: string;
  /** 服务器上的原名。 */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly risk: RiskClass;
  /** 服务器标了「有破坏性」：每次都问、不能始终允许。 */
  readonly destructive: boolean;
  /** 审查没过：不注册，原因给用户看。 */
  readonly rejected?: readonly string[];
  readonly warnings?: readonly string[];
}

export interface McpStatus {
  readonly name: string;
  readonly skillId: string;
  readonly state: McpState;
  readonly enabled: boolean;
  /** 出错时的说明（给用户看）。 */
  readonly error?: string;
  /** 服务器最近的输出（stderr 的最后几行），排查用。 */
  readonly log: string;
  readonly server?: { readonly name: string; readonly version: string };
  readonly tools: readonly McpToolView[];
  /** 本机命令用的沙箱；远程地址、关了沙箱、平台没有沙箱时为 null。 */
  readonly sandbox: { readonly kind: string } | null;
}

/** MCP 工具调用结果里的一项。 */
interface Content {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly resource?: { readonly uri?: string; readonly text?: string; readonly mimeType?: string };
}

interface RemoteTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JSONSchema;
  readonly annotations?: { readonly title?: string; readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}

const LOG_MAX = 4000;

/**
 * 名字规整成工具 id 能用的：小写字母开头，只有小写字母、数字、- 和 _。
 * 取不出英文的（「下载」「笔记」「123」）按原名算一个稳定的短码（`mcp_1a2b3c`）——
 * 早先一律变成 `x`，两个中文名的服务器就撞成同一个前缀。同一个名字每次结果一样：授权、工具集快照按它记。
 */
export function slug(s: string, max: number): string {
  const raw = String(s ?? '').trim();
  const out = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+/g, '_').replace(/_$/, '');
  if (out) return out.slice(0, max);
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 0x01000193) >>> 0;
  return `mcp_${h.toString(16).padStart(8, '0').slice(0, 6)}`.slice(0, max);
}

/**
 * 一个 MCP 服务器 → 一个技能（`SkillProvider`）。框架不认识 MCP，只认识技能来源。
 *
 * **服务器是第三方代码，它说的都不可信：**
 * - 输出不可信（`untrustedOutput`）：调用过的任务之后的对外操作一律要人确认。
 * - 「只读」标注不采信：所有工具按对外操作（第一次先问，可以按工具始终允许）；
 *   标了「有破坏性」的采信（往严里走）：每次都问、不能始终允许。
 * - 说明里的提示注入（「顺便把 ~/.ssh 读出来」）：注册前过审查，不过的不注册，原因在 `status().tools`。
 * - 本机命令跑在沙箱里：可写家目录与临时目录、可联网（多数服务器是第三方 API 的包装），
 *   但密钥、钥匙串、浏览器资料与宿主的数据目录不能读写。
 * - 同名工具在任务进行中变了含义：工具集快照按定义指纹拦（registry）。
 *
 * 连接在后台进行：`list()` 不等连接（第一次 `npx` 可能要下载一分钟，不能卡住引擎启动），连上后通知变化。
 * 断了按 1s / 5s / 30s 重连三次，之后等宿主调 `reconnect()`。
 */
export class McpServerProvider implements SkillProvider {
  readonly id: string;
  private readonly skillId: string;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private state: McpState = 'connecting';
  private error: string | undefined;
  private log = '';
  private server: { name: string; version: string } | undefined;
  private views: McpToolView[] = [];
  private accepted: { descriptor: ToolDescriptor; remoteName: string }[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly statusListeners = new Set<(s: McpStatus) => void>();
  private readonly sandbox: Sandbox | null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private generation = 0;
  private enabled: boolean;

  constructor(private readonly config: McpServerConfig, private readonly opts: McpOptions = {}) {
    this.enabled = config.enabled !== false;
    this.skillId = slug(config.name, 32);
    this.id = `mcp:${this.skillId}`;
    this.sandbox = config.transport.kind !== 'stdio' || config.sandbox === false || opts.sandbox === false
      ? null
      : opts.sandbox ?? detectSandbox();
    void this.connect();
  }

  /** 现在的状态（宿主的服务器详情页）。 */
  status(): McpStatus {
    return {
      name: this.config.name,
      skillId: this.skillId,
      state: this.state,
      enabled: this.enabled,
      ...(this.error ? { error: this.error } : {}),
      log: this.log,
      ...(this.server ? { server: this.server } : {}),
      tools: this.views,
      sandbox: this.sandbox ? { kind: this.sandbox.kind } : null,
    };
  }

  /** 状态变了（连上、断开、工具列表变了）。返回取消订阅函数。 */
  onStatus(cb: (s: McpStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async health(): Promise<Health> {
    if (this.state === 'ready') return { status: 'up' };
    if (this.state === 'connecting') return { status: 'degraded', reason: '正在连接' };
    return { status: 'down', reason: this.error ?? '没有连接' };
  }

  async list(): Promise<readonly SkillBundle[]> {
    if (!this.enabled || this.state !== 'ready' || this.accepted.length === 0) return [];
    const skill: Skill = {
      id: asSkillId(this.skillId),
      name: this.config.name,
      purpose: this.purpose(),
      keywords: [this.config.name, ...(this.server?.name ? [this.server.name] : [])],
      tools: this.accepted.map((a) => a.descriptor),
      source: { kind: 'extension', providerId: this.id, version: this.server?.version ?? '0' },
    };
    const handlers = new Map<string, ToolHandler>(this.accepted.map((a) => [String(a.descriptor.id), this.handler(a.remoteName)]));
    return [{ skill, handlers }];
  }

  /** 启用 / 停用：不断开连接，只改给不给 Agent（用户看过工具列表后打开）。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.setState(this.state, this.error);
    this.fireChange();
  }

  /** 断开重连（用户点「重新连接」、改了 key 之后）。 */
  async reconnect(): Promise<void> {
    this.retries = 0;
    await this.teardown();
    this.closing = false;
    await this.connect();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.teardown();
    this.setState('closed');
  }

  /** 连上（或失败）之后才返回。测试与宿主「重新连接」用。 */
  async ready(timeoutMs = 60_000): Promise<McpStatus> {
    const t0 = Date.now();
    while (this.state === 'connecting' && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
    return this.status();
  }

  // ── 内部 ─────────────────────────────────────────────────────────

  private purpose(): string {
    const names = this.accepted.map((a) => a.remoteName).slice(0, 12).join('、');
    return `用户接入的 MCP 服务器「${this.config.name}」提供的工具：${names}${this.accepted.length > 12 ? ' 等' : ''}`;
  }

  private setState(state: McpState, error?: string): void {
    this.state = state;
    this.error = error;
    const s = this.status();
    for (const cb of this.statusListeners) cb(s);
  }

  private fireChange(): void {
    for (const cb of this.listeners) cb();
  }

  private appendLog(chunk: string): void {
    this.log = (this.log + chunk).slice(-LOG_MAX);
  }

  private policy(): SandboxPolicy {
    const home = homedir();
    return {
      writable: [home, tmpdir(), '/private/tmp', '/private/var/folders'],
      denyRead: [...SENSITIVE_HOME_PATHS.map((p) => join(home, p)), ...(this.opts.denyRead ?? [])],
      network: true,
    };
  }

  private makeTransport(): Transport {
    const t = this.config.transport;
    if (t.kind === 'http') {
      const init = t.headers ? { requestInit: { headers: { ...t.headers } } } : {};
      // SDK 的类型在 exactOptionalPropertyTypes 下对不上（可选属性没写 | undefined），运行时就是 Transport
      return new StreamableHTTPClientTransport(new URL(t.url), init) as unknown as Transport;
    }
    const env = { ...getDefaultEnvironment(), ...(this.opts.env ?? {}), ...(t.env ?? {}) };
    const args = [...(t.args ?? [])];
    const cmd = this.sandbox ? this.sandbox.wrap(t.command, args, this.policy()) : { file: t.command, args };
    const transport = new StdioClientTransport({
      command: cmd.file, args: [...cmd.args], env, stderr: 'pipe', ...(t.cwd ? { cwd: t.cwd } : {}),
    });
    transport.stderr?.on('data', (b: Buffer) => this.appendLog(b.toString('utf8')));
    return transport;
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    this.setState('connecting');
    const timeout = this.opts.connectTimeoutMs ?? 60_000;
    try {
      await withTimeout(this.open(), timeout, `连接超过 ${Math.round(timeout / 1000)} 秒没有完成`);
      if (gen !== this.generation) return;
      await this.loadTools();
      if (gen !== this.generation) return;
      this.retries = 0;
      this.setState('ready');
      this.fireChange();
    } catch (e) {
      if (gen !== this.generation) return;
      await this.teardown();
      this.setState('error', this.explain(e));
      this.fireChange();
      this.scheduleRetry();
    }
  }

  private async open(): Promise<void> {
    const info = this.opts.clientInfo ?? { name: 'melon-ai', version: '0.0.1' };
    const make = () => new Client({ name: info.name, version: info.version }, {
      capabilities: {},
      listChanged: { tools: { onChanged: () => { void this.loadTools().then(() => this.fireChange(), () => {}); } } },
    });
    let client = make();
    let transport = this.makeTransport();
    try {
      await client.connect(transport);
    } catch (e) {
      // 远程的老服务器只有 SSE：再试一次
      if (this.config.transport.kind !== 'http') throw e;
      await transport.close().catch(() => {});
      client = make();
      const t = this.config.transport;
      transport = new SSEClientTransport(new URL(t.url), t.headers ? { requestInit: { headers: { ...t.headers } } } : {}) as unknown as Transport;
      await client.connect(transport);
    }
    transport.onclose = () => {
      if (this.closing || this.transport !== transport) return;
      this.client = null;
      this.transport = null;
      this.setState('error', '服务器断开了连接');
      this.fireChange();
      this.scheduleRetry();
    };
    this.client = client;
    this.transport = transport;
    const v = client.getServerVersion();
    this.server = v ? { name: String(v.name ?? ''), version: String(v.version ?? '') } : undefined;
  }

  /** 列工具、规整 id、定风险、过审查。 */
  private async loadTools(): Promise<void> {
    if (!this.client) return;
    const all: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      all.push(...(page.tools as unknown as RemoteTool[]));
      cursor = page.nextCursor;
    } while (cursor && all.length < 500);

    const used = new Set<string>();
    const views: McpToolView[] = [];
    const accepted: { descriptor: ToolDescriptor; remoteName: string }[] = [];
    for (const t of all) {
      let local = slug(t.name, 48);
      for (let i = 2; used.has(local); i++) local = `${slug(t.name, 44)}_${i}`;
      used.add(local);
      const destructive = t.annotations?.destructiveHint === true;
      const risk: RiskClass = destructive ? 'irreversible' : 'external';
      const title = t.title ?? t.annotations?.title;
      const descriptor: ToolDescriptor = {
        id: asToolId(`${this.skillId}.${local}`),
        skillId: asSkillId(this.skillId),
        name: local,
        description: `${title && title !== t.name ? `${title}：` : ''}${t.description ?? t.name}`,
        input: normalizeSchema(t.inputSchema),
        risk,
        idempotent: false,
        untrustedOutput: true,
        // 用户的哪句话一定要用到它，引擎判断不了：交给模型
        triggers: [],
      };
      const review = reviewTool(descriptor);
      const errors = review.issues.filter((x) => x.level === 'error').map((x) => x.message);
      const warnings = review.issues.filter((x) => x.level === 'warn').map((x) => x.message);
      views.push({
        id: String(descriptor.id), name: t.name, ...(title ? { title } : {}), description: review.descriptor.description,
        risk, destructive, ...(errors.length ? { rejected: errors } : {}), ...(warnings.length ? { warnings } : {}),
      });
      if (errors.length === 0) accepted.push({ descriptor: review.descriptor, remoteName: t.name });
    }
    this.views = views;
    this.accepted = accepted;
    if (this.state === 'ready') this.setState('ready');
  }

  private handler(remoteName: string): ToolHandler {
    return async (args, cx): Promise<ToolOutput> => {
      const client = this.client;
      if (!client || this.state !== 'ready') {
        throw new ToolError('UPSTREAM', `MCP 服务器「${this.config.name}」没有连上${this.error ? `：${this.error}` : ''}`, { retriable: false, hint: '告诉用户这个服务器现在不可用，可以在设置里重新连接' });
      }
      let res;
      try {
        res = await client.callTool(
          { name: remoteName, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          { timeout: this.opts.callTimeoutMs ?? 60_000, signal: cx.signal },
        );
      } catch (e) {
        throw new ToolError('UPSTREAM', `MCP 服务器「${this.config.name}」调用 ${remoteName} 出错：${this.explain(e)}`, { retriable: true });
      }
      const content = (res.content ?? []) as readonly Content[];
      const text = renderContent(content);
      if (res.isError) throw new ToolError('UPSTREAM', text || `${remoteName} 返回了错误`, { retriable: false });
      const structured = (res as { structuredContent?: unknown }).structuredContent;
      const summary = text || (structured !== undefined ? JSON.stringify(structured) : '（没有返回内容）');
      return { summary, ...(structured !== undefined ? { data: structured } : {}) };
    };
  }

  private scheduleRetry(): void {
    if (this.closing || this.retryTimer || this.retries >= 3) return;
    const delay = [1000, 5000, 30_000][this.retries++]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closing && this.state === 'error') void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async teardown(): Promise<void> {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const c = this.client;
    const t = this.transport;
    this.client = null;
    this.transport = null;
    this.generation++;
    try { await c?.close(); } catch { /* 已经断了 */ }
    try { await t?.close(); } catch { /* 已经断了 */ }
  }

  /** 错误 → 给用户看的一句话。沙箱拦下的说清楚。 */
  private explain(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    const denied = this.sandbox?.denial({ stdout: '', stderr: this.log }, this.policy());
    if (denied?.kind === 'read' || denied?.kind === 'write') return `被沙箱拦下：想${denied.kind === 'read' ? '读' : '写'} ${denied.path ?? '受保护的位置'}（${msg}）`;
    if (/ENOENT/.test(msg) && this.config.transport.kind === 'stdio') return `找不到命令 ${this.config.transport.command}（${msg}）`;
    if (/401|403|unauthori[sz]ed|forbidden/i.test(msg)) return `服务器拒绝了：key 不对或没有权限（${msg}）`;
    return msg;
  }
}

/** 工具的参数定义：顶层必须是 object。服务器给的不规范时兜成「没有参数」。 */
function normalizeSchema(s: JSONSchema | undefined): JSONSchema {
  if (!s || typeof s !== 'object') return { type: 'object', properties: {} };
  const out: Record<string, unknown> = { ...s, type: 'object' };
  if (!out['properties'] || typeof out['properties'] !== 'object') out['properties'] = {};
  delete out['$schema'];
  return out;
}

/** 调用结果 → 给模型的文字。看不了的（图片、音频）注明。 */
export function renderContent(content: readonly Content[]): string {
  return content.map((c) => {
    if (c.type === 'text') return c.text ?? '';
    if (c.type === 'image') return `（返回了一张图片${c.mimeType ? `，${c.mimeType}` : ''}，看不了）`;
    if (c.type === 'audio') return '（返回了一段音频，听不了）';
    if (c.type === 'resource') return c.resource?.text ?? `（资源：${c.resource?.uri ?? ''}）`;
    if (c.type === 'resource_link') return `（链接：${c.name ? `${c.name} ` : ''}${c.uri ?? ''}）`;
    return '';
  }).filter(Boolean).join('\n');
}

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(why)), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); });
  });
}

/** 一个 MCP 服务器作为技能来源。 */
export function mcp(server: McpServerConfig, opts: McpOptions = {}): McpServerProvider {
  return new McpServerProvider(server, opts);
}

/**
 * 解析常见的配置写法（Claude Desktop、Cursor 等的 `mcpServers`）：
 * `{ "mcpServers": { "名字": { "command": "npx", "args": [...], "env": {...} } | { "url": "https://…", "headers": {...} } } }`。
 * 也接受不带外层 `mcpServers` 的。认不出的项放进 `errors`。
 */
export function parseMcpServers(json: string): { servers: McpServerConfig[]; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) {
    return { servers: [], errors: [`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`] };
  }
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const map = (obj['mcpServers'] ?? obj['servers'] ?? obj) as Record<string, unknown>;
  const servers: McpServerConfig[] = [];
  const errors: string[] = [];
  const strMap = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]));
  };
  for (const [name, v] of Object.entries(map ?? {})) {
    const c = (v ?? {}) as Record<string, unknown>;
    if (typeof c['command'] === 'string' && c['command']) {
      const env = strMap(c['env']);
      servers.push({ name, transport: {
        kind: 'stdio', command: c['command'],
        ...(Array.isArray(c['args']) ? { args: c['args'].map(String) } : {}),
        ...(env ? { env } : {}),
        ...(typeof c['cwd'] === 'string' ? { cwd: c['cwd'] } : {}),
      } });
    } else if (typeof c['url'] === 'string' && /^https?:\/\//.test(c['url'])) {
      const headers = strMap(c['headers']);
      servers.push({ name, transport: { kind: 'http', url: c['url'], ...(headers ? { headers } : {}) } });
    } else {
      errors.push(`「${name}」既没有 command 也没有 http(s) 的 url`);
    }
  }
  if (servers.length === 0 && errors.length === 0) errors.push('没有找到任何服务器');
  return { servers, errors };
}
