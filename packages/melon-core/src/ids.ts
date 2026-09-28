/**
 * 带品牌的 ID 类型。运行时就是 string，编译期不可互换 —— 避免把 TaskId 传给收 EpisodeId 的参数。
 */
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type TaskId = Brand<string, 'TaskId'>;
export type EpisodeId = Brand<string, 'EpisodeId'>;
export type MemoryId = Brand<string, 'MemoryId'>;
export type ArtifactRef = Brand<string, 'ArtifactRef'>;
export type CallId = Brand<string, 'CallId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type SkillId = Brand<string, 'SkillId'>;
/** 全局唯一的工具标识，形如 `${SkillId}.${name}`。 */
export type ToolId = Brand<string, 'ToolId'>;

export const asTaskId = (s: string): TaskId => s as TaskId;
export const asEpisodeId = (s: string): EpisodeId => s as EpisodeId;
export const asMemoryId = (s: string): MemoryId => s as MemoryId;
export const asArtifactRef = (s: string): ArtifactRef => s as ArtifactRef;
export const asCallId = (s: string): CallId => s as CallId;
export const asAgentId = (s: string): AgentId => s as AgentId;
export const asSkillId = (s: string): SkillId => s as SkillId;
export const asToolId = (s: string): ToolId => s as ToolId;

/** 事件日志里的序号包装。seq 在单个任务内单调递增，从 1 开始。 */
export interface Sequenced<T> {
  readonly seq: number;
  readonly at: number;
  readonly value: T;
}

export interface Scored<T> {
  readonly item: T;
  readonly score: number;
}
