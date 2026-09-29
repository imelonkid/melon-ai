import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ToolError } from '@melon-ai/core';

/**
 * 最小的 SMTP 客户端：发一封纯文本邮件所需的全部，不多做。
 *
 * 不引第三方库：SMTP 是一个稳定了几十年的文本协议，发信只用到 EHLO / STARTTLS / AUTH /
 * MAIL / RCPT / DATA / QUIT 七个命令；为它引一个依赖，换来的是体积和供应链风险。
 *
 * 两种加密方式都支持：
 * - `secure: true`：连上就是 TLS（465 端口，163 / QQ 邮箱常用）
 * - `secure: false`：先明文连上，服务器支持就升级 STARTTLS（587 端口）
 *
 * **不在明文连接上发送密码** —— 服务器不支持 STARTTLS 时直接报错，
 * 除非显式设了 `allowInsecureAuth`（只给本地测试服务器用）。
 */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** true = 连上就是 TLS（465）；false = 明文连上后升级 STARTTLS（587）。 */
  readonly secure: boolean;
  /** 登录名，一般就是邮箱地址。 */
  readonly user: string;
  /** 密码或授权码（163 / QQ 邮箱要用授权码，不是登录密码）。 */
  readonly pass: string;
  /** 发件地址。默认同 user。 */
  readonly from?: string;
  /** 发件人显示名。 */
  readonly fromName?: string;
  /** 只给本地测试服务器用：允许在没有 TLS 的连接上登录。 */
  readonly allowInsecureAuth?: boolean;
  /** 单次操作的超时，默认 20s。 */
  readonly timeoutMs?: number;
}

export interface MailMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** 按行读 SMTP 应答。多行应答形如 `250-xxx`，最后一行 `250 xxx`。 */
class Conn {
  private buf = '';
  private waiting: ((r: Reply | Error) => void) | null = null;
  private pending: string[] = [];
  private error: Error | null = null;

  private readonly onData = (d: Buffer) => { this.buf += d.toString('utf8'); this.drain(); };
  private readonly onError = (e: Error) => this.fail(e);
  private readonly onClose = () => this.fail(new Error('邮件服务器断开了连接'));

  constructor(public socket: Socket) {
    this.attach(socket);
  }

  /**
   * 换一条底层连接（STARTTLS 升级后）。旧连接上的监听必须摘掉 ——
   * 否则升级后的密文也会被当成应答行读进来。
   */
  attach(socket: Socket): void {
    if (this.socket !== socket) {
      this.socket.off('data', this.onData).off('error', this.onError).off('close', this.onClose);
    }
    this.socket = socket;
    this.buf = '';
    this.pending = [];
    socket.on('data', this.onData).on('error', this.onError).on('close', this.onClose);
  }

  /** 升级前摘掉监听，把原始连接交给 TLS。 */
  detach(): Socket {
    this.socket.off('data', this.onData).off('error', this.onError).off('close', this.onClose);
    return this.socket;
  }

  private fail(e: Error): void {
    this.error ??= e;
    const w = this.waiting;
    this.waiting = null;
    w?.(e);
  }

  private drain(): void {
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.pending.push(line);
      // 最后一行：三位码后面是空格（或行只有三位码）
      if (/^\d{3}(?: |$)/.test(line)) {
        const lines = this.pending;
        this.pending = [];
        const w = this.waiting;
        this.waiting = null;
        w?.({ code: Number(line.slice(0, 3)), lines: lines.map((l) => l.slice(4)) });
      }
    }
  }

  read(): Promise<Reply> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiting = (r) => (r instanceof Error ? reject(r) : resolve(r));
      this.drain();
    });
  }

  async cmd(line: string, expect: readonly number[], what: string): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    const r = await this.read();
    if (!expect.includes(r.code)) throw smtpError(r, what);
    return r;
  }
}

function smtpError(r: Reply, what: string): ToolError {
  const text = `${what}失败：${r.code} ${r.lines.join(' ')}`.trim();
  if (r.code === 535 || r.code === 534 || r.code === 530) {
    return new ToolError('DENIED', `邮件服务器拒绝登录（${r.code}）`, {
      retriable: false, hint: '检查邮箱地址和授权码。163 / QQ 邮箱要在网页版设置里开启 SMTP，并使用授权码而不是登录密码',
    });
  }
  if (what.startsWith('收件人') && r.code >= 500) {
    return new ToolError('INVALID_ARGS', text, { hint: '收件人地址被服务器拒绝，确认地址是否正确' });
  }
  return new ToolError('UPSTREAM', text, { retriable: r.code >= 400 && r.code < 500 });
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
/** 非 ASCII 的头部用 RFC 2047 编码。 */
const encodeWord = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap = (s: string, n = 76): string => s.replace(new RegExp(`(.{${n}})`, 'g'), '$1\r\n');

export const EMAIL = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/;

/** 组装一封纯文本邮件（base64 正文，UTF-8）。 */
export function buildMessage(from: string, fromName: string | undefined, msg: MailMessage, now = new Date()): string {
  const domain = from.split('@')[1] ?? 'localhost';
  const headers = [
    `From: ${fromName ? `${encodeWord(fromName)} <${from}>` : from}`,
    `To: ${msg.to.join(', ')}`,
    `Subject: ${encodeWord(msg.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrap(b64(msg.text))}`;
}

async function open(cfg: SmtpConfig, signal: AbortSignal): Promise<Conn> {
  const timeout = cfg.timeoutMs ?? 20_000;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = cfg.secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : netConnect({ host: cfg.host, port: cfg.port });
    const ready = cfg.secure ? 'secureConnect' : 'connect';
    s.setTimeout(timeout, () => s.destroy(new Error(`连接邮件服务器超时（${cfg.host}:${cfg.port}）`)));
    s.once(ready, () => resolve(s));
    s.once('error', (e) => reject(connectError(cfg, e)));
  });
  const onAbort = () => socket.destroy(new Error('已取消'));
  signal.addEventListener('abort', onAbort, { once: true });
  socket.once('close', () => signal.removeEventListener('abort', onAbort));
  return new Conn(socket);
}

function connectError(cfg: SmtpConfig, e: Error): ToolError {
  const code = (e as { code?: string }).code ?? '';
  return new ToolError('UPSTREAM', `连不上邮件服务器 ${cfg.host}:${cfg.port}（${code || e.message}）`, {
    hint: '检查服务器地址和端口；465 端口要选 SSL，587 端口选 STARTTLS',
  });
}

const capabilities = (r: Reply): Set<string> => new Set(r.lines.map((l) => l.toUpperCase()));

/** 连上、握手、（升级 TLS）、登录。返回已登录的连接。 */
async function login(cfg: SmtpConfig, signal: AbortSignal): Promise<Conn> {
  const c = await open(cfg, signal);
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw smtpError(greet, '连接');
    const me = hostname() || 'localhost';
    let caps = capabilities(await c.cmd(`EHLO ${me}`, [250], '握手'));
    let encrypted = cfg.secure;

    if (!encrypted && [...caps].some((l) => l.startsWith('STARTTLS'))) {
      await c.cmd('STARTTLS', [220], '升级加密');
      const raw = c.detach();
      const secured = await new Promise<Socket>((resolve, reject) => {
        const t = tlsConnect({ socket: raw, servername: cfg.host }, () => resolve(t));
        t.once('error', reject);
      });
      c.attach(secured);
      encrypted = true;
      caps = capabilities(await c.cmd(`EHLO ${me}`, [250], '握手'));
    }
    if (!encrypted && !cfg.allowInsecureAuth) {
      throw new ToolError('DENIED', '邮件服务器不支持加密连接，拒绝明文发送授权码', {
        retriable: false, hint: '改用 465 端口 + SSL，或 587 端口 + STARTTLS',
      });
    }

    const auth = [...caps].find((l) => l.startsWith('AUTH')) ?? '';
    if (/\bPLAIN\b/.test(auth)) {
      await c.cmd(`AUTH PLAIN ${b64(`\u0000${cfg.user}\u0000${cfg.pass}`)}`, [235], '登录');
    } else {
      await c.cmd('AUTH LOGIN', [334], '登录');
      await c.cmd(b64(cfg.user), [334], '登录');
      await c.cmd(b64(cfg.pass), [235], '登录');
    }
    return c;
  } catch (e) {
    c.socket.destroy();
    throw e;
  }
}

/** 发一封邮件。返回服务器接受的收件人。 */
export async function sendMail(cfg: SmtpConfig, msg: MailMessage, signal: AbortSignal): Promise<{ accepted: readonly string[] }> {
  const from = cfg.from || cfg.user;
  const c = await login(cfg, signal);
  try {
    await c.cmd(`MAIL FROM:<${from}>`, [250], '发件人');
    for (const to of msg.to) await c.cmd(`RCPT TO:<${to}>`, [250, 251], `收件人 ${to} `);
    await c.cmd('DATA', [354], '发送正文');
    // 点填充：正文里以 . 开头的行前面再加一个点，否则会被当成结束标记
    const body = buildMessage(from, cfg.fromName, msg).replace(/\r\n\./g, '\r\n..');
    await c.cmd(`${body}\r\n.`, [250], '发送正文');
    await c.cmd('QUIT', [221], '断开').catch(() => undefined);
    return { accepted: msg.to };
  } finally {
    c.socket.destroy();
  }
}

/** 只验证能连上并登录，不发信。给配置页的「测试」用。 */
export async function verifySmtp(cfg: SmtpConfig, signal: AbortSignal): Promise<void> {
  const c = await login(cfg, signal);
  await c.cmd('QUIT', [221], '断开').catch(() => undefined);
  c.socket.destroy();
}
