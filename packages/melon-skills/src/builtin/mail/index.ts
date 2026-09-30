/**
 * `@melon-ai/skills/mail` —— 内置技能：发邮件（SMTP）。
 *
 * 单独一个子路径：要用 Node 的 net / tls。技能包根入口因此保持与运行时无关。
 *
 * ```ts
 * import { mail } from '@melon-ai/agent/mail';
 * agent.configure({ skills: [mail({ smtp: { host: 'smtp.163.com', port: 465, secure: true, user, pass } })] });
 * ```
 *
 * - 发邮件是对外操作（risk external）：每封都先问用户，读过网页的任务之后更是一律要问
 * - 收件人必须是邮箱地址：写「产品组」这种名字会报错，模型就会去问用户要地址，而不是自己编一个
 * - 没配邮箱时**不提供**发邮件工具：用户说「发邮件」，引擎直接回答没有合适的工具，不会编造「已发送」
 */
import type { Health, SkillBundle, SkillProvider } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { defineTool } from '../../registry/define.js';
import { EMAIL, sendMail, verifySmtp } from './smtp.js';
import type { SmtpConfig } from './smtp.js';

export { buildMessage, sendMail, verifySmtp, EMAIL } from './smtp.js';
export type { SmtpConfig, MailMessage } from './smtp.js';

export const MAIL_SEND = 'mail.send';

/**
 * 常见邮箱服务的 SMTP 参数。和模型预设一样只是一组配置（地址、端口、加密方式），宿主的配置页据此自动填，
 * 用户只用填邮箱地址和授权码。名字给人看的部分由宿主决定。
 */
export const SMTP_PRESETS: Readonly<Record<string, { readonly host: string; readonly port: number; readonly secure: boolean; readonly domains: readonly string[] }>> = {
  '163': { host: 'smtp.163.com', port: 465, secure: true, domains: ['163.com'] },
  '126': { host: 'smtp.126.com', port: 465, secure: true, domains: ['126.com'] },
  qq: { host: 'smtp.qq.com', port: 465, secure: true, domains: ['qq.com', 'foxmail.com'] },
  exmail: { host: 'smtp.exmail.qq.com', port: 465, secure: true, domains: [] },
  aliyun: { host: 'smtp.aliyun.com', port: 465, secure: true, domains: ['aliyun.com'] },
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true, domains: ['gmail.com', 'googlemail.com'] },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false, domains: ['outlook.com', 'hotmail.com', 'live.com'] },
};

/** 按邮箱地址的域名猜是哪家。猜不出返回 null（企业邮箱通常要用户自己选或填）。 */
export function smtpPresetFor(address: string): string | null {
  const domain = String(address ?? '').split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  return Object.entries(SMTP_PRESETS).find(([, p]) => p.domains.includes(domain))?.[0] ?? null;
}

/** 发邮件的触发词。用户的话里出现这些，模型就必须真的调用发邮件工具。 */
export const MAIL_TRIGGERS: readonly string[] = [
  '发邮件', '发送邮件', '发封邮件', '发一封', '邮件发给', '邮件给', '邮件通知', '发信', '发给', '发送给',
  // 「发到我的邮箱」「寄给」「发至」—— 第二轮人工验收里「发到我的邮箱」没被认出来，模型用文字征求确认就结束了
  '发到', '发至', '寄给',
  'send email', 'send an email', 'email to', 'mail to',
];

/** 一个或多个邮箱地址（逗号、分号分隔）。收件人不合格的调用在问用户之前就被退回。 */
const ONE = '[^\\s@,;，；<>]+@[^\\s@,;，；<>]+\\.[^\\s@,;，；<>]+';
export const RECIPIENTS_PATTERN = `^\\s*${ONE}(\\s*[,;，；]\\s*${ONE})*\\s*$`;

/** 「a@x.com, b@y.com」「a@x.com；b@y.com」→ 地址数组。 */
export function parseRecipients(to: string): string[] {
  return String(to ?? '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
}

export interface MailSkillOptions {
  /** SMTP 配置。null / 不传 = 不提供发邮件工具。 */
  readonly smtp?: SmtpConfig | null;
}

export class MailSkillProvider implements SkillProvider {
  readonly id = 'melon-mail';
  private smtp: SmtpConfig | null;
  private readonly listeners = new Set<() => void>();

  constructor(opts: MailSkillOptions = {}) {
    this.smtp = opts.smtp ?? null;
  }

  /** 宿主改了邮箱配置（换授权码、停用）时调用。 */
  setSmtp(smtp: SmtpConfig | null): void {
    const changed = (this.smtp === null) !== (smtp === null);
    this.smtp = smtp;
    if (changed) for (const cb of this.listeners) cb();
  }

  get configured(): boolean {
    return this.smtp !== null;
  }

  async list(): Promise<readonly SkillBundle[]> {
    if (!this.smtp) return [];
    const send = defineTool<{ to: string; subject: string; body: string }>({
      id: MAIL_SEND,
      description: '以用户的邮箱发送一封邮件。收件人必须是完整的邮箱地址（多个用逗号分隔）；不知道地址就先问用户，不要猜。',
      risk: 'external',
      // 「始终允许」只看收件人 —— 允许发给 a 不等于允许发给任何人
      scope: ['to'],
      triggers: MAIL_TRIGGERS,
      input: {
        to: {
          // 收件人必须是用户说过的：不许编（第二轮验收：模型填了 product-team@example.com），也不许从网页里抄
          type: 'string', pattern: RECIPIENTS_PATTERN, fromUser: true,
          description: '收件人要写成完整的邮箱地址，多个用逗号分隔，如 a@example.com, b@example.com；不知道地址就先问用户，不要猜，也不要填占位符',
        },
        subject: { type: 'string', description: '主题' },
        body: { type: 'string', description: '正文（纯文本）' },
      },
      run: async ({ to, subject, body }, cx) => {
        const smtp = this.smtp;
        // 审批期间可能被停用
        if (!smtp) throw new ToolError('FATAL', '邮箱已停用', { retriable: false, hint: '告诉用户需要先配置邮箱' });
        const list = parseRecipients(to);
        const bad = list.filter((a) => !EMAIL.test(a));
        if (list.length === 0 || bad.length > 0) {
          throw new ToolError('INVALID_ARGS', `收件人要写成邮箱地址：${bad.join('、') || '（空）'}`, {
            hint: '向用户问清楚收件人的邮箱地址，不要猜',
          });
        }
        const r = await sendMail(smtp, { to: list, subject: String(subject), text: String(body ?? '') }, cx.signal);
        return `邮件已发送：「${subject}」→ ${r.accepted.join('、')}`;
      },
    });
    return [{
      skill: {
        id: send.descriptor.skillId,
        name: '邮件',
        purpose: '需要以用户的名义发送邮件时使用',
        keywords: ['邮件', '发邮件', 'email', 'mail'],
        tools: [send.descriptor],
        source: { kind: 'builtin' },
      },
      handlers: new Map([[MAIL_SEND, send.handler]]),
    }];
  }

  async health(): Promise<Health> {
    return { status: 'up' };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}

/** 发邮件技能的简写。不传 smtp 时不提供工具。 */
export function mail(opts: MailSkillOptions = {}): MailSkillProvider {
  return new MailSkillProvider(opts);
}

export interface MailTestResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly code?: string;
  readonly error?: string;
  readonly hint?: string;
}

/**
 * 验证能连上并登录（不发信）。给宿主配置页的「测试」用 —— 与 `testModel` / `testSearch` 同一个思路。
 */
export async function testMail(smtp: SmtpConfig, timeoutMs = 20_000): Promise<MailTestResult> {
  const started = Date.now();
  try {
    await verifySmtp({ ...smtp, timeoutMs }, AbortSignal.timeout(timeoutMs));
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    const err = e as { code?: string; message?: string; hint?: string };
    return {
      ok: false, ms: Date.now() - started,
      code: err.code ?? 'FATAL',
      error: String(err.message ?? e),
      ...(err.hint ? { hint: err.hint } : {}),
    };
  }
}
