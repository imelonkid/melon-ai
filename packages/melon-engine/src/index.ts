/**
 * @melon-ai/engine —— 引擎。
 *
 * - task：任务状态机（纯 reducer）、预算、守卫
 * - runtime：事务边界、EffectRunner、调度与崩溃恢复
 * - trigger：定时编排（周期规则是纯函数）
 *
 * 分层见 docs/architecture.md §3；目录之间的依赖方向由 .dependency-cruiser.cjs 强制。
 */
export * from './task/index.js';
export * from './runtime/index.js';
export * from './trigger/index.js';
