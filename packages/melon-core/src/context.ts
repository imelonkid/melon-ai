import type { Message } from './model.js';
import type { ToolSignature } from './tool.js';

/**
 * 上下文槽位。装配顺序 = **稳定性递减**，这个顺序不是美学，是省钱：
 * prompt cache 命中的是公共前缀，把每次都变的东西（当前时间、observation）放前面，
 * 会让整个前缀每轮失效，缓存收益归零。一个 20 步的 ReAct 任务，
 * 前缀稳不稳的成本差是数倍。
 */
export const SLOT_ORDER = [
  'charter',      // 全局宪章        —— 几乎永不变
  'persona',      // Agent 人设      —— 编辑时才变
  'toolSchemas',  // 钉住的工具签名   —— 任务内不变
  'memories',     // L1 检索结果     —— 轮次间可能变
  'summaries',    // 压缩后的 episode —— 压缩时才变
  'recent',       // 最近原文轮次     —— 每轮都变
  'volatile',     // 环境事实 + 当前 observation —— 每步都变
] as const;

export type SlotName = (typeof SLOT_ORDER)[number];

/** 各槽位占模型窗口的比例。用比例而非绝对 token 数，以适配不同窗口的模型。 */
export type BudgetPlan = Readonly<Record<SlotName, number>>;

export const DEFAULT_BUDGET_PLAN: BudgetPlan = {
  charter: 0.03,
  persona: 0.02,
  toolSchemas: 0.15,
  memories: 0.10,
  summaries: 0.15,
  recent: 0.30,
  volatile: 0.15,
  // 余下 0.10 留给输出
};

export interface Slot {
  readonly name: SlotName;
  readonly messages: readonly Message[];
  readonly tokens: number;
  readonly budget: number;
  /** 本槽位是否发生了截断。发生了就该考虑触发压缩。 */
  readonly truncated: boolean;
}

export interface ContextBundle {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSignature[];
  readonly slots: readonly Slot[];
  readonly totalTokens: number;
  readonly window: number;
  /** 超过这个水位就该压缩。默认 0.70。 */
  readonly watermark: number;
}

export type CompactTrigger =
  | 'watermark'      // token 水位超限
  | 'episode-closed' // episode 关闭，排队异步压
  | 'topic-shift'    // 话题切换
  | 'pre-toolchain'; // 长工具链开始前预先腾空间

/** 永不压缩的内容。压了这些会直接破坏任务的连贯性或正确性。 */
export const NEVER_COMPACT: readonly SlotName[] = ['charter', 'persona', 'volatile'];
