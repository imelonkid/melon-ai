/**
 * `@melon-ai/agent/agentskills` —— 加载用户装的 Agent Skills（agentskills.io 规范，Claude 的技能格式）。
 *
 * ```ts
 * import { agentSkills } from '@melon-ai/agent/agentskills';
 * const skills = agentSkills({ dirs: [`${home}/.myapp/skills`, `${home}/.agents/skills`] });
 * const agent = await createAgent({ skills: [skills] });
 * skills.report();   // 哪些加载了、哪些被拦下及原因（给界面展示）
 * ```
 *
 * 每个技能注册前都要过校验、净化、审查；执行技能里的脚本每次都要用户确认，脚本跑在沙箱里（macOS：Seatbelt）。
 */
export {
  agentSkills, AgentSkillsProvider, scanSkillDirs, reviewSkillDir, parseSkillMd, isRejected,
  seatbelt, detectSandbox, sensitivePaths,
} from '@melon-ai/skills/agentskills';
export type {
  AgentSkillsOptions, AgentSkillsReport, AgentSkill, RejectedSkill, ScanLimits,
} from '@melon-ai/skills/agentskills';
