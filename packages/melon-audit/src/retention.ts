import type { RetentionPolicy } from '@melon-ai/core';

export class InvalidRetentionError extends Error {
  constructor(p: RetentionPolicy) {
    super(
      `负载保留期（${p.payloadDays} 天）短于审计保留期（${p.auditDays} 天）。` +
      `这会让大部分审计轨迹解不开引用 —— 要么延长负载保留期，` +
      `要么确保 AuditRecord.dimensions 足以在负载消失后仍然回答审计问题。`,
    );
    this.name = 'InvalidRetentionError';
  }
}

/**
 * 启动时校验保留策略。
 *
 * §2.4 坑三：审计留 2 年、负载 90 天清一次，结果 90% 的轨迹解不开。
 * 这类配置错误必须在启动时拒绝，而不是等到有人来查审计才发现。
 */
export function assertRetention(p: RetentionPolicy): void {
  if (p.payloadDays < p.auditDays) throw new InvalidRetentionError(p);
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  auditDays: 365,
  payloadDays: 365,
  // 对外发送、花钱、删除这三类不随保留期清理
  keepForever: ['tool.invoke', 'approval.decide', 'policy.change'],
};
