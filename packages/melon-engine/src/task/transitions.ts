import type { TaskEventType, TaskState } from '@melon-ai/core';

/**
 * 合法迁移表。
 *
 * 做成**数据**而不是 switch 嵌套：非法迁移是「查表查不到」，
 * 而不是「漏写了一个 case 悄悄走到 default」。
 * 表也可以被测试直接遍历，保证每条迁移都有覆盖。
 */
export type TransitionKey = `${TaskState}+${TaskEventType}`;

/**
 * 目标状态。`'derived'` 表示目标取决于事件载荷（例如 `PlanProduced` 的 step 种类、
 * `Settled` 的 outcome），由 reducer 计算 —— 但**必须落在 allowed 列出的集合内**。
 */
export interface Transition {
  readonly to: TaskState | 'derived';
  readonly allowed?: readonly TaskState[];
  readonly note?: string;
}

const T = (to: TaskState, note?: string): Transition => (note === undefined ? { to } : { to, note });
const D = (allowed: readonly TaskState[], note?: string): Transition =>
  note === undefined ? { to: 'derived', allowed } : { to: 'derived', allowed, note };

export const TRANSITIONS: Readonly<Record<string, Transition>> = {
  'PENDING+Started': T('PLANNING'),

  // skill_query 是自环；tool_call 进准入；spawn 挂起等子任务；final 由 reducer 发 Settled
  'PLANNING+PlanProduced': D(['PLANNING', 'ADMITTING', 'SUSPENDED']),
  'PLANNING+SkillsInjected': T('PLANNING'),
  'PLANNING+Settled': D(['SUCCEEDED', 'FAILED', 'CANCELLED']),
  'PLANNING+Suspended': T('SUSPENDED', '等外部事件或定时'),
  'PLANNING+LoopDetected': T('OBSERVING', '循环拦在准入之前，所以从 PLANNING 发生'),

  'ADMITTING+AdmissionResolved': D(
    ['EXECUTING', 'AWAITING_APPROVAL', 'OBSERVING'],
    'deny 走 OBSERVING —— 拒绝是给模型的信息，不是错误',
  ),

  'AWAITING_APPROVAL+ApprovalRequested': T('AWAITING_APPROVAL', '仅记录，状态不变'),
  'AWAITING_APPROVAL+ApprovalResolved': D(['EXECUTING', 'OBSERVING']),

  'EXECUTING+ToolCallStarted': T('EXECUTING', '仅记录 span 与时序'),
  'EXECUTING+ToolCallFinished': T('OBSERVING'),

  'OBSERVING+Observed': D(['PLANNING', 'OBSERVING'], '预算/守卫触发时留在 OBSERVING'),
  'OBSERVING+BudgetExhausted': T('OBSERVING', '记录后由 reducer 发 Settled'),
  'OBSERVING+LoopDetected': T('OBSERVING'),
  'OBSERVING+NoProgress': T('OBSERVING'),
  'OBSERVING+Settled': D(['SUCCEEDED', 'FAILED', 'CANCELLED']),

  'SUSPENDED+Resumed': T('PLANNING'),
  'SUSPENDED+ChildSpawned': T('SUSPENDED', '仅记录'),
  'SUSPENDED+ChildSettled': D(['SUSPENDED', 'PLANNING'], '全部子任务收敛后才回 PLANNING'),
  'SUSPENDED+Settled': D(['SUCCEEDED', 'FAILED', 'CANCELLED']),

  // Compacted 是内务事件，任何非终态都可以发生且不改变状态
  'PLANNING+Compacted': T('PLANNING'),
  'OBSERVING+Compacted': T('OBSERVING'),
  'SUSPENDED+Compacted': T('SUSPENDED'),
  'AWAITING_APPROVAL+Compacted': T('AWAITING_APPROVAL'),
};

/** Cancelled 在任何非终态都合法，单列以免把表写成笛卡尔积。 */
export const CANCELLABLE_FROM: readonly TaskState[] = [
  'PENDING', 'PLANNING', 'ADMITTING', 'AWAITING_APPROVAL', 'EXECUTING', 'OBSERVING', 'SUSPENDED',
];

export function lookup(state: TaskState, event: TaskEventType): Transition | undefined {
  if (event === 'Cancelled') {
    return CANCELLABLE_FROM.includes(state) ? { to: 'CANCELLED' } : undefined;
  }
  if (event === 'Created') return state === 'PENDING' ? { to: 'PENDING' } : undefined;
  return TRANSITIONS[`${state}+${event}`];
}
