import type {
  AdmissionDecision, AdmissionOutcome, AgentId, BuiltinToolId, Grant, PolicyMode,
  QuotaSnapshot, RiskClass, ToolId,
} from '@melon-ai/core';
import { ADMISSION_MATRIX, DURABLE_WRITE_TOOLS, TAINT_FORCES_ASK } from '@melon-ai/core';
import { checkQuota } from './quota.js';
import { scopeMatches } from './scope.js';

/**
 * 判定输入。
 *
 * 所有 I/O 结果（授权、配额、技能是否开启）都由调用方查好传进来 ——
 * 判定本身必须是纯函数，才能把整张矩阵和所有覆盖规则用表驱动测完。
 */
export interface DecideInput {
  readonly agentId: AgentId;
  readonly toolId: ToolId;
  readonly risk: RiskClass;
  readonly scope: string;
  readonly mode: PolicyMode;
  /** 本 episode 是否消费过不可信的扩展工具输出。 */
  readonly tainted: boolean;
  /** 该 skill 是否对这个 agent 开启（Agent 编辑器里的工具开关）。 */
  readonly skillEnabled: boolean;
  /** 匹配到的「始终允许」，没有则 null。 */
  readonly grant: Grant | null;
  /** 配额快照，null 表示不限。 */
  readonly quota: QuotaSnapshot | null;
  readonly now: number;
}

const out = (
  decision: AdmissionDecision,
  reason: string,
  basis: Record<string, string | number | boolean>,
  matchedGrant?: Grant,
): AdmissionOutcome =>
  matchedGrant === undefined
    ? { decision, reason, basis }
    : { decision, reason, basis, matchedGrant };

const writesDurableState = (toolId: ToolId): boolean =>
  (DURABLE_WRITE_TOOLS as readonly string[]).includes(toolId as unknown as BuiltinToolId);

/**
 * 准入判定。四道闸，顺序有意义：
 *
 * 1. **授权** —— 没开启的技能直接拒。不能让未授权的工具走到「问用户」那一步，
 *    否则等于把授权决定推给了用户，而用户当初关掉它就是不想被问。
 * 2. **配额** —— 早于矩阵。矩阵说 ask 但配额已爆时，不该先问用户再失败。
 * 3. **污点** —— 早于授权匹配。这是关键顺序：攻击路径正是
 *    「污染 → 模型写记忆 → 已有的 always 授权自动放行」，
 *    所以污点必须能覆盖 grant，否则整条防线形同虚设。
 * 4. **授权匹配 → 矩阵**。
 */
export function decide(input: DecideInput): AdmissionOutcome {
  const { toolId, risk, mode, scope } = input;

  // ① 授权
  if (!input.skillEnabled) {
    return out('deny', '该工具所属技能未对此 Agent 开启', {
      gate: 'authorization', toolId, skillEnabled: false,
    });
  }

  // ② 配额
  const q = checkQuota(input.quota);
  if (!q.ok) {
    return out('deny', q.reason ?? '配额不足', {
      gate: 'quota', toolId, quotaKind: q.which ?? 'unknown',
      usedUSD: input.quota?.usedUSD ?? 0, limitUSD: input.quota?.limitUSD ?? 0,
    });
  }

  // ③ 污点覆盖 —— 必须早于授权匹配
  if (TAINT_FORCES_ASK && input.tainted && writesDurableState(toolId)) {
    return out('ask', '本轮处理过来自扩展工具的不可信内容，写入持久记忆前需要你确认', {
      gate: 'taint', toolId, tainted: true, mode, risk,
      overrode: input.grant ? 'grant' : 'matrix',
    });
  }

  // ④ 授权匹配
  const g = input.grant;
  if (g && g.agentId === input.agentId && g.toolId === toolId && scopeMatches(g.scope, scope)) {
    if (g.expiresAt !== undefined && g.expiresAt <= input.now) {
      // 过期的授权不匹配，落回矩阵，而不是当成拒绝
    } else {
      return out('allow', `命中「始终允许」：${toolId} ${scope}`, {
        gate: 'grant', toolId, scope, grantedAt: g.grantedAt, mode, risk,
      }, g);
    }
  }

  // ⑤ 矩阵
  const decision = ADMISSION_MATRIX[mode][risk];
  const reason = decision === 'allow'
    ? `策略「${mode}」下 ${risk} 类操作自动执行`
    : decision === 'ask'
      ? `策略「${mode}」下 ${risk} 类操作需要你确认`
      : `策略「${mode}」不允许 ${risk} 类操作`;
  return out(decision, reason, { gate: 'matrix', toolId, scope, mode, risk });
}

/** 用户点「始终允许」时构造授权记录。 */
export function grantFrom(input: DecideInput, at: number, ttlMs?: number): Grant {
  const base = { agentId: input.agentId, toolId: input.toolId, scope: input.scope, grantedAt: at };
  return ttlMs === undefined ? base : { ...base, expiresAt: at + ttlMs };
}
