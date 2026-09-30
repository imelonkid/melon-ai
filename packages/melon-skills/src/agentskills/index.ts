/**
 * `@melon-ai/skills/agentskills` —— 加载 Agent Skills（agentskills.io 规范，Claude 的技能用的就是它）。
 *
 * 从 Claude 或其他兼容产品拿来的技能目录，放进宿主指定的目录就能用：
 *
 * ```ts
 * import { agentSkills } from '@melon-ai/agent/agentskills';
 * const skills = agentSkills({ dirs: [`${home}/.myapp/skills`, `${home}/.agents/skills`] });
 * const agent = await createAgent({ skills: [skills] });
 * skills.report();   // 哪些加载了、哪些被拦下及原因
 * skills.reload();   // 用户装了新技能之后
 * ```
 *
 * 需要 Node（文件系统、子进程），所以走子路径。
 */
export * from './frontmatter.js';
export * from './scan.js';
export * from './provider.js';
