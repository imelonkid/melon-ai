/**
 * @melon-ai/skills —— 技能。
 *
 * - pipeline：工具调用六段管线（解析→校验→准入→执行→归一化→记录）
 * - policy：准入矩阵、污点覆盖、授权匹配（管线的第 ③ 段）
 * - registry：`defineTool` / `defineSkill` 与工具注册表；注册前的校验、净化、审查
 * - builtin：内置技能。与运行时无关的在这里导出（完整内容、定时任务草稿、记忆）；
 *   需要 Node 的走子路径：`./web`（联网）、`./mail`（发邮件）
 * - `./agentskills` 子路径：加载 Agent Skills 规范的技能目录（Node）
 */
export * from './pipeline/index.js';
export * from './policy/index.js';
export * from './registry/index.js';
export * from './builtin/artifact/index.js';
export * from './builtin/schedule/index.js';
export * from './builtin/memory/index.js';
