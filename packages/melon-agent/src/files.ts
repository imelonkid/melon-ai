/**
 * `@melon-ai/agent/files` —— 内置技能：本地文件（Node 宿主）。列目录、找文件、读内容（文本；PDF、Word、Excel 抽文字），只读。
 *
 * ```ts
 * import { files } from '@melon-ai/agent/files';
 * await agent.configure({ skills: [files({ denyRead: [appDataDir] })] });
 * await agent.grants.add(FILES_GRANT_KEY, folderScope('~/Downloads'));   // 宿主替用户预先允许一个文件夹
 * ```
 *
 * 读到的内容会发给模型厂商：每次先问用户，「始终允许」按文件夹（含子文件夹）。受保护的位置（密钥、钥匙串、浏览器资料、宿主数据）不读。
 */
export { files, FilesSkillProvider, FILES_GRANT_KEY, folderScope, folderCovers, canonicalPath } from '@melon-ai/skills/files';
export type { FilesSkillOptions } from '@melon-ai/skills/files';
