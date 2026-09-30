/**
 * `@melon-ai/agent/mail` —— 内置技能：发邮件（SMTP，Node 宿主）。
 *
 * ```ts
 * import { mail, testMail } from '@melon-ai/agent/mail';
 * const smtp = { host: 'smtp.163.com', port: 465, secure: true, user: 'me@163.com', pass: 授权码 };
 * await testMail(smtp);                                  // 配置页的「测试」：只登录，不发信
 * await agent.configure({ skills: [mail({ smtp })] });   // 停用：mail({ smtp: null })
 * ```
 *
 * 每封邮件发出前都会问用户；收件人必须是邮箱地址；没配邮箱时模型拿不到这个工具。
 */
export {
  mail, testMail, MailSkillProvider, MAIL_SEND, MAIL_TRIGGERS, SMTP_PRESETS, EMAIL, parseRecipients, sendMail, verifySmtp, buildMessage,
} from '@melon-ai/skills/mail';
export type { SmtpConfig, MailMessage, MailSkillOptions, MailTestResult } from '@melon-ai/skills/mail';
