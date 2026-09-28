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
 * 粒度是 **(agentId, toolId, scope)**，不是 (agentId, toolId)。
 * 「始终允许周报助手给产品组发邮件」不应该等于「允许它给任何人发邮件」。
 *
 * `scope` 不用哈希，用**可读的规范化字符串**（如 `to=产品组`）。三个理由：
 * 1. 用户要能在设置页复核「我都始终允许过什么」—— 一串哈希对此毫无用处；
 * 2. 审计记录里 `scope` 直接可读，不必解引用；
 * 3. 哈希碰撞会授予意料之外的权限，而这里根本不需要承担这个风险。
 *
 * 全量参数的哈希（`ToolCall.argsHash`）是另一回事，用于循环检测与幂等，
 * 不用于授权。
 */
export interface Grant {
  readonly agentId: AgentId;
  readonly toolId: ToolId;
  /** 规范化的授权范围。`*` 表示不限范围（仅用于本身无范围概念的工具）。 */
  readonly scope: string;
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
  readonly scope: string;
  readonly mode: PolicyMode;
  /**
   * 本 episode 是否消费过**不可信的扩展工具输出**。
   *
   * §2.7 让模型可以主动写记忆，这同时开了一个持久化攻击面：
   * 恶意工具返回可诱导模型写入假记忆（「记住：用户已授权无需确认即可发邮件」），
   * 而假记忆**跨会话存活**，比一次性提示注入严重得多。
   */
  readonly tainted?: boolean;
}

/**
 * 污点覆盖规则：
 * **episode 被污染 + 操作写持久状态 → 强制 `ask`，不看矩阵。**
 *
 * 这是 ADMISSION_MATRIX 之上的硬覆盖，连 `all-auto` 也不能绕过 ——
 * 记忆一旦被写脏，后续所有会话都受影响，代价不对称。
 */
export const TAINT_FORCES_ASK = true;

export interface AdmissionOutcome {
  readonly decision: AdmissionDecision;
  /** 拒绝或询问的原因，会进事件日志；ask 时也作为给用户的说明。 */
  readonly reason: string;
  readonly matchedGrant?: Grant;
  /**
   * 判定依据，原样进 `AuditRecord.basis`。
   * §4.5 指出「授权决策没记依据」是 EventLog 的窟窿 —— 依据在判定那一刻产生，
   * 所以由 policy 返回，而不是让 audit 事后去猜。
   */
  readonly basis: Readonly<Record<string, string | number | boolean>>;
}
