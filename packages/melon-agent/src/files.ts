/**
 * `@melon-ai/agent/files` —— 内置技能：本地文件（Node 宿主）。列目录、找文件、读内容（文本；PDF、Word、Excel 抽文字）；可选的整理。
 *
 * ```ts
 * import { files } from '@melon-ai/agent/files';
 * await agent.configure({ skills: [files({ denyRead: [appDataDir] })] });
 * await agent.grants.add(FILES_GRANT_KEY, folderScope('~/Downloads'));   // 宿主替用户预先允许一个文件夹
 * ```
 *
 * 读到的内容会发给模型厂商：每次先问用户，「始终允许」按文件夹（含子文件夹）。受保护的位置（密钥、钥匙串、浏览器资料、宿主数据）不读。
 *
 * 附件：`prepareAttachment(path)` 抽出文字，交给 `agent.run(goal, { attachments })`。
 * 生成文件：`outputs({ dir })` —— Agent 把内容写成文件放在输出目录里，用户自己另存。
 *
 * 整理：`files({ organize: true, trash })` —— 新建文件夹、移动 / 重命名、复制、新建文本文件、移到废纸篓（`trash` 由宿主给）。
 * 每次调用记下改了什么（`ToolResultMeta.changes`，随事件落盘）；宿主用 `undoState(changes)` 决定卡片上显不显示「撤销」，
 * `undoChanges(changes, { trash, prot })` 撤销 —— 之后被改过的不动。
 */
export {
  files, FilesSkillProvider, FILES_GRANT_KEY, FILES_ORGANIZE_GRANT_KEY, folderScope, folderCovers, canonicalPath, prepareAttachment, outputs,
  undoState, undoChanges,
} from '@melon-ai/skills/files';
export type { FilesSkillOptions, UndoState, UndoResult } from '@melon-ai/skills/files';
