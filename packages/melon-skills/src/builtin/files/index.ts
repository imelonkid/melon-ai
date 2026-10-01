/**
 * `@melon-ai/skills/files` —— 本地文件：列目录、找文件、读文件内容（文本；PDF、Word、Excel 抽文字）；可选的整理（移动、复制、新建、移到废纸篓，可撤销）。
 *
 * 单独一个子路径：要 Node 的文件系统和文档解析依赖（unpdf、mammoth、jszip），技能包的根入口保持与运行时无关。
 * 读到的内容会发给模型厂商：按对外操作处理，先问用户；「始终允许」按文件夹。受保护的位置不读，内容不可信。
 */
export * from './provider.js';
export * from './attach.js';
export * from './outputs.js';
export { FILES_ORGANIZE_GRANT_KEY, undoState, undoChanges } from './organize.js';
export type { UndoState, UndoResult } from './organize.js';
export { FILES_GRANT_KEY, folderScope, folderCovers, canonical as canonicalPath } from './paths.js';
