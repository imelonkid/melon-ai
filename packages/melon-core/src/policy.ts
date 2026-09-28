import type { AgentId, ToolId } from './ids.js';
import type { RiskClass } from './tool.js';

/** 对应设置页「Agent 执行权限」三档。 */
export type PolicyMode = 'ask' | 'low-risk-auto' | 'all-auto';

export type AdmissionDecision = 'allow' | 'ask' | 'deny';

/**
 * 风险 × 策略矩阵。
 *
 * 注意 `spend` 和 `irreversible` 在 **all-auto 下依然是 ask**：
 * 用户点「全部自动」时想的是「别拿读邮件这种事烦我」，不是「可以替我花钱」。
 * 这条写死在矩阵里，不留给运行时判断。
 */
export const ADMISSION_MATRIX: Readonly<Record<PolicyMode, Readonly<Record<RiskClass, AdmissionDecision>>>> = {
  'ask': {
    read: 'ask', write: 'ask', external: 'ask', spend: 'ask', irreversible: 'ask',
  },
  'low-risk-auto': {
    read: 'allow', write: 'allow', external: 'ask', spend: 'ask', irreversible: 'ask',
  },
  'all-auto': {
    read: 'allow', write: 'allow', external: 'allow', spend: 'ask', irreversible: 'ask',
  },
} as const;

/**
 * 「始终允许」的授权记录。
 *
 * 粒度是 **(agentId, toolId, argsShapeHash)**，不是 (agentId, toolId)。
 * 「始终允许周报助手给产品组发邮件」不应该等于「允许它给任何人发邮件」。
 */
export interface Grant {
  readonly agentId: AgentId;
  readonly toolId: ToolId;
  readonly argsShapeHash: string;
  readonly grantedAt: number;
  readonly expiresAt?: number;
}

export interface QuotaSnapshot {
  readonly window: 'day' | 'month';
  readonly usedUSD: number;
  readonly limitUSD: number;
  readonly usedCalls: number;
  readonly limitCalls: number;
}

export interface AdmissionInput {
  readonly agentId: AgentId;
  readonly toolId: ToolId;
  readonly risk: RiskClass;
  readonly argsShapeHash: string;
  readonly mode: PolicyMode;
}

export interface AdmissionOutcome {
  readonly decision: AdmissionDecision;
  /** 拒绝或询问的原因，会进事件日志；ask 时也作为给用户的说明。 */
  readonly reason: string;
  readonly matchedGrant?: Grant;
}
