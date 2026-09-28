import type { AgentId, ArtifactRef, EpisodeId, MemoryId, TaskId } from './ids.js';

// ─────────────────────────────  L0 内置记忆  ─────────────────────────────

/**
 * L0 = 固定记忆。三段拼接，顺序固定，且**易变的部分必须放最后**
 * （见 docs/architecture.md 的前缀稳定性：把每次都变的东西放前面会让 prompt cache 全废）。
 */
export interface Constitution {
  /** 全局宪章：安全边界、对外操作前确认、语气基线。所有 Agent 共享，用户改不了。 */
  readonly charter: string;
  /** Agent 人设。对应 Agent 编辑器的「角色与指令」。 */
  readonly persona: string;
  /** 环境事实：日期、用户名、时区、已授权 skill、当前模型。每次生成，所以放最后。 */
  readonly environment: string;
  readonly personaVersion: string;
}

// ─────────────────────────────  L1 长期记忆  ─────────────────────────────

export type MemoryScope = 'user' | 'agent' | 'workspace';
export type MemoryKind = 'fact' | 'preference' | 'procedure' | 'entity';

export interface Memory {
  readonly id: MemoryId;
  readonly scope: MemoryScope;
  readonly agentId?: AgentId;
  readonly kind: MemoryKind;
  /** 归一化的主题键。用于精确匹配和冲突检测。 */
  readonly subject: string;
  /** 一条，一句，自包含。不要写成需要上下文才能理解的片段。 */
  readonly statement: string;
  readonly confidence: number;
  readonly importance: number;
  /** 可溯源、可撤销。用户问「你为什么以为我喜欢 X」时靠它回答。 */
  readonly provenance: { readonly taskId: TaskId; readonly eventSeq: number };
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly useCount: number;
  /**
   * 指向被本条替代的旧记忆。冲突用「新增 + supersedes」而不是原地改，
   * 是为了保留可解释性和可撤销性 —— 原地更新会把这条链路彻底丢掉。
   */
  readonly supersedes?: MemoryId;
  readonly ttl?: number;
}

export interface MemoryQuery {
  readonly scope: MemoryScope;
  readonly agentId?: AgentId;
  readonly kinds?: readonly MemoryKind[];
  readonly text?: string;
  readonly subject?: string;
  readonly limit: number;
  /** 排除已被 supersede 的条目。默认 true。 */
  readonly activeOnly?: boolean;
}

/** 从 L2 抽出、还没落库的候选记忆。 */
export interface MemoryCandidate {
  readonly kind: MemoryKind;
  readonly subject: string;
  readonly statement: string;
  readonly importance: number;
  readonly confidence: number;
}

// ─────────────────────────────  L2 短期记忆  ─────────────────────────────

export type EntryKind = 'user' | 'assistant' | 'thought' | 'tool_call' | 'observation' | 'system';

export interface Entry {
  readonly kind: EntryKind;
  readonly text: string;
  readonly at: number;
  readonly tokens?: number;
  readonly artifactRef?: ArtifactRef;
}

export type EpisodeState = 'open' | 'closed' | 'compacted';

/**
 * 一个 episode ≈ 一个用户请求从提出到解决。
 * **只有 closed 的 episode 才能被压缩** —— 压一个还在推理中的链路会直接破坏连贯性。
 */
export interface Episode {
  readonly id: EpisodeId;
  readonly rootId: TaskId;
  readonly state: EpisodeState;
  readonly openedAt: number;
  readonly closedAt?: number;
  readonly summary?: EpisodeSummary;
}

/**
 * 压缩产物是**结构化的，不是散文**。三个理由：
 * 1. 可二次压缩而不失真（散文压两轮就开始丢事实）
 * 2. facts / artifacts 可以直接进全文索引
 * 3. facts 正好是 L1 提升的输入，不用再抽一遍
 */
export interface EpisodeSummary {
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly facts: readonly string[];
  readonly artifacts: readonly { readonly ref: ArtifactRef; readonly what: string }[];
  readonly openItems: readonly string[];
  readonly outcome: 'resolved' | 'abandoned' | 'carried-over';
}
