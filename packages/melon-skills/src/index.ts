/**
 * @melon-ai/skills —— 技能。
 *
 * - pipeline：工具调用六段管线（解析→校验→准入→执行→归一化→记录）
 * - policy：准入矩阵、污点覆盖、授权匹配（管线的第 ③ 段）
 *
 * 待建：技能注册与召回、内置工具、联网工具、MCP 接入。
 */
export * from './pipeline/index.js';
export * from './policy/index.js';
