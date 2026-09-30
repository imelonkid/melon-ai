import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import type { ToolContext } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { MAIL_SEND, SMTP_PRESETS, mail, parseRecipients, sendMail, smtpPresetFor, testMail } from '../../src/builtin/mail/index.js';
import type { SmtpConfig } from '../../src/builtin/mail/index.js';

/**
 * 本地假 SMTP 服务器：按行应答，记下收到的命令与正文。
 * 不做 TLS —— 客户端用 allowInsecureAuth 连它；加密路径靠真实邮箱人工验收。
 */
interface Fake {
  readonly port: number;
  readonly commands: string[];
  readonly data: string[];
  close(): Promise<void>;
}

async function fakeSmtp(opts: { auth?: 'PLAIN' | 'LOGIN'; password?: string; rejectRcpt?: string; noAuth?: boolean } = {}): Promise<Fake> {
  const commands: string[] = [];
  const data: string[] = [];
  const server: Server = createServer((sock) => {
    let buf = '';
    let inData = false;
    let loginStep = 0;
    let body = '';
    const say = (l: string) => sock.write(`${l}\r\n`);
    say('220 fake.test ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; data.push(body); body = ''; say('250 OK queued'); continue; }
          body += `${line}\r\n`;
          continue;
        }
        commands.push(line);
        const pass = opts.password ?? 'secret';
        if (loginStep === 1) { loginStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
        if (loginStep === 2) {
          loginStep = 0;
          say(Buffer.from(line, 'base64').toString() === pass ? '235 OK' : '535 auth failed');
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) {
          say('250-fake.test');
          say(opts.noAuth ? '250 SIZE 1000000' : `250 AUTH ${opts.auth ?? 'PLAIN LOGIN'}`);
        } else if (up.startsWith('AUTH PLAIN')) {
          const [, user, pw] = Buffer.from(line.slice(11), 'base64').toString().split('\u0000');
          say(user && pw === pass ? '235 OK' : '535 auth failed');
        } else if (up === 'AUTH LOGIN') {
          loginStep = 1; say('334 VXNlcm5hbWU6');
        } else if (up.startsWith('MAIL FROM')) say('250 OK');
        else if (up.startsWith('RCPT TO')) say(opts.rejectRcpt && line.includes(opts.rejectRcpt) ? '550 no such user' : '250 OK');
        else if (up === 'DATA') { inData = true; say('354 go ahead'); }
        else if (up === 'QUIT') { say('221 bye'); sock.end(); }
        else say('502 unknown');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    commands, data,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const cfg = (port: number, over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1', port, secure: false, user: 'me@test.com', pass: 'secret', allowInsecureAuth: true, ...over,
});

const cx = (): ToolContext => ({
  taskId: 't' as never, callId: 'c' as never, trace: {} as never, signal: new AbortController().signal,
  putArtifact: async () => 'art-1' as never, readArtifact: async () => '', log: () => {},
});

const code = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'ok'; } catch (e) { return e instanceof ToolError ? e.code : String(e); }
};

test('发信：AUTH PLAIN 登录，信封与正文正确，中文主题按 RFC 2047 编码，行首的点做了填充', async () => {
  const s = await fakeSmtp();
  try {
    await sendMail(cfg(s.port, { fromName: '小林' }), {
      to: ['a@x.com', 'b@y.com'], subject: '本周周报', text: '第一行\n.以点开头的行',
    }, new AbortController().signal);
    assert.ok(s.commands.some((c) => c.startsWith('AUTH PLAIN')));
    assert.ok(s.commands.includes('MAIL FROM:<me@test.com>'));
    assert.deepEqual(s.commands.filter((c) => c.startsWith('RCPT')), ['RCPT TO:<a@x.com>', 'RCPT TO:<b@y.com>']);
    const msg = s.data[0]!;
    assert.match(msg, /Subject: =\?UTF-8\?B\?/);
    assert.match(msg, /From: =\?UTF-8\?B\?[^?]+\?= <me@test\.com>/);
    assert.match(msg, /To: a@x\.com, b@y\.com/);
    const body = Buffer.from(msg.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString();
    assert.equal(body, '第一行\n.以点开头的行');
  } finally { await s.close(); }
});

test('发信：服务器只支持 AUTH LOGIN 时走 LOGIN', async () => {
  const s = await fakeSmtp({ auth: 'LOGIN' });
  try {
    await sendMail(cfg(s.port), { to: ['a@x.com'], subject: 'x', text: 'y' }, new AbortController().signal);
    assert.ok(s.commands.includes('AUTH LOGIN'));
    assert.equal(s.data.length, 1);
  } finally { await s.close(); }
});

test('授权码错是 DENIED，提示用授权码；收件人被拒是 INVALID_ARGS', async () => {
  const s = await fakeSmtp({ rejectRcpt: 'nobody@x.com' });
  try {
    const bad = await sendMail(cfg(s.port, { pass: 'wrong' }), { to: ['a@x.com'], subject: 'x', text: 'y' }, new AbortController().signal)
      .catch((e) => e);
    assert.equal(bad.code, 'DENIED');
    assert.match(bad.hint, /授权码/);
    assert.equal(await code(sendMail(cfg(s.port), { to: ['nobody@x.com'], subject: 'x', text: 'y' }, new AbortController().signal)), 'INVALID_ARGS');
  } finally { await s.close(); }
});

test('本机地址的服务器默认允许明文登录（回环连接不出本机）', async () => {
  const s = await fakeSmtp();
  try {
    const { allowInsecureAuth: _drop, ...plain } = cfg(s.port);
    await sendMail(plain, { to: ['a@x.com'], subject: 'x', text: 'y' }, new AbortController().signal);
    assert.equal(s.data.length, 1);
  } finally { await s.close(); }
});

test('服务器不支持加密时，拒绝在明文连接上发授权码', async () => {
  const s = await fakeSmtp();
  try {
    const e = await sendMail(cfg(s.port, { allowInsecureAuth: false }), { to: ['a@x.com'], subject: 'x', text: 'y' }, new AbortController().signal)
      .catch((x) => x);
    assert.equal(e.code, 'DENIED');
    assert.match(e.message, /明文/);
    assert.ok(!s.commands.some((c) => c.startsWith('AUTH')), '一个字节的授权码都不能发出去');
  } finally { await s.close(); }
});

test('连不上服务器是 UPSTREAM，带服务器地址与端口提示', async () => {
  const s = await fakeSmtp();
  const port = s.port;
  await s.close();
  const e = await sendMail(cfg(port), { to: ['a@x.com'], subject: 'x', text: 'y' }, new AbortController().signal).catch((x) => x);
  assert.equal(e.code, 'UPSTREAM');
  assert.match(e.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
});

test('技能：没配邮箱就不提供发邮件工具；配上后出现，是对外操作、按收件人授权、带触发词', async () => {
  const p = mail();
  assert.deepEqual(await p.list(), []);
  let fired = 0;
  p.onChange(() => fired++);
  p.setSmtp(cfg(1));
  assert.equal(fired, 1);
  const [b] = await p.list();
  const d = b!.skill.tools[0]!;
  assert.equal(d.id, MAIL_SEND);
  assert.equal(d.risk, 'external');
  assert.deepEqual(d.scopeKeys, ['to']);
  assert.ok(d.triggers?.includes('发邮件'));
  assert.equal(b!.skill.source.kind, 'builtin');
});

test('工具：收件人写成「产品组」这种名字时报 INVALID_ARGS，让模型去问地址', async () => {
  const s = await fakeSmtp();
  try {
    const p = mail({ smtp: cfg(s.port) });
    const [b] = await p.list();
    const h = b!.handlers.get(MAIL_SEND)!;
    assert.equal(await code(h({ to: '产品组', subject: 'x', body: 'y' }, cx())), 'INVALID_ARGS');
    assert.equal(s.data.length, 0, '一封都不能发出去');
    const out = await h({ to: 'a@x.com；b@y.com', subject: '周报', body: '内容' }, cx());
    assert.match(out.summary, /已发送/);
    assert.equal(s.data.length, 1);
  } finally { await s.close(); }
});

test('parseRecipients：中英文逗号、分号、空白都能分', () => {
  assert.deepEqual(parseRecipients('a@x.com, b@y.com；c@z.com  d@w.com'), ['a@x.com', 'b@y.com', 'c@z.com', 'd@w.com']);
});

test('testMail：能登录就 ok，不发信；授权码错带错误码与提示', async () => {
  const s = await fakeSmtp();
  try {
    const ok = await testMail(cfg(s.port));
    assert.equal(ok.ok, true);
    assert.equal(s.data.length, 0);
    const bad = await testMail(cfg(s.port, { pass: 'nope' }));
    assert.deepEqual([bad.ok, bad.code], [false, 'DENIED']);
    assert.match(bad.hint ?? '', /授权码/);
  } finally { await s.close(); }
});

test('SMTP 预设：按域名认出常见邮箱；认不出返回 null', () => {
  assert.equal(smtpPresetFor('me@163.com'), '163');
  assert.equal(smtpPresetFor('Me@FoxMail.com'), 'qq');
  assert.equal(smtpPresetFor('me@corp.example'), null);
  assert.deepEqual([SMTP_PRESETS['163']!.port, SMTP_PRESETS['163']!.secure], [465, true]);
  assert.deepEqual([SMTP_PRESETS['outlook']!.port, SMTP_PRESETS['outlook']!.secure], [587, false]);
});
