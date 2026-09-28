import type { SkillId, ToolId } from './ids.js';
import type { RiskClass } from './tool.js';

/**
 * ─── 内置工具 ───
 *
 * §2.7「一切读写经由工具」的落地面。这些工具让模型能主动访问记忆、历史、
 * artifact 与技能目录 —— 而不是由框架悄悄注入。
 *
 * **内置工具走完整的六段管线，没有快速通道。**
 * 这是该原则全部安全收益的来源：准入、配额、审计、幂等对它们一视同仁。
 */
export const BUILTIN_SKILL_ID = 'builtin' as SkillId;

export const BUILTIN_TOOLS = {
  /** 检索 L1 长期记忆。模型自主决定何时需要。 */
  MEMORY_RECALL: 'builtin.memory_recall' as ToolId,
  /** 写入 L1。风险 write —— 但见 taint 规则，可能被强制升级为需确认。 */
  MEMORY_WRITE: 'builtin.memory_write' as ToolId,
  /**
   * 删除 L1 记忆。风险 irreversible ——
   * 按 ADMISSION_MATRIX，三档策略下**都需要用户确认**。
   * Agent 想删用户的记忆必须先问，这是矩阵免费给出的性质。
   */
  MEMORY_FORGET: 'builtin.memory_forget' as ToolId,
  /** 在 L2 历史里检索。最近 N 轮是注入的，更早的靠这个深挖。 */
  HISTORY_SEARCH: 'builtin.history_search' as ToolId,
  /** 读取已压缩 episode 的原文。压缩有损，但原文永远留着。 */
  HISTORY_READ: 'builtin.history_read' as ToolId,
  /** 按句柄读取大结果。上下文里只有 summary + ref，细节走这里。 */
  ARTIFACT_READ: 'builtin.artifact_read' as ToolId,
  /** 循环内重新召回技能 —— 避免首轮把工具集钉死后无路可走。 */
  SKILL_FIND: 'builtin.skill_find' as ToolId,
  /** 取工具的全量 schema。常驻上下文只有签名。 */
  TOOL_DESCRIBE: 'builtin.tool_describe' as ToolId,
} as const;

export type BuiltinToolId = (typeof BUILTIN_TOOLS)[keyof typeof BUILTIN_TOOLS];

export const BUILTIN_RISK: Readonly<Record<BuiltinToolId, RiskClass>> = {
  [BUILTIN_TOOLS.MEMORY_RECALL]: 'read',
  [BUILTIN_TOOLS.MEMORY_WRITE]: 'write',
  [BUILTIN_TOOLS.MEMORY_FORGET]: 'irreversible',
  [BUILTIN_TOOLS.HISTORY_SEARCH]: 'read',
  [BUILTIN_TOOLS.HISTORY_READ]: 'read',
  [BUILTIN_TOOLS.ARTIFACT_READ]: 'read',
  [BUILTIN_TOOLS.SKILL_FIND]: 'read',
  [BUILTIN_TOOLS.TOOL_DESCRIBE]: 'read',
};

/**
 * 写持久状态的工具集合。
 * taint 规则（见 policy.ts `TAINT_FORCES_ASK`）只作用于这一组。
 */
export const DURABLE_WRITE_TOOLS: readonly BuiltinToolId[] = [
  BUILTIN_TOOLS.MEMORY_WRITE,
  BUILTIN_TOOLS.MEMORY_FORGET,
];
