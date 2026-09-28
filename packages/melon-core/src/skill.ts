import type { AgentId, SkillId } from './ids.js';
import type { ToolDescriptor, ToolHandler } from './tool.js';

export interface AuthSpec {
  readonly kind: 'none' | 'oauth2' | 'apiKey' | 'custom';
  readonly scopes?: readonly string[];
}

export type SkillSource =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'extension'; readonly providerId: string; readonly version: string };

export interface Skill {
  readonly id: SkillId;
  readonly name: string;
  /**
   * 「**什么时候该用我**」，不是「我是什么」。召回质量几乎全靠这一句。
   * 坏：`邮件工具集`
   * 好：`需要读取收件箱、起草或发送邮件，或按发件人/主题查找往来邮件时使用`
   */
  readonly purpose: string;
  readonly keywords: readonly string[];
  readonly tools: readonly ToolDescriptor[];
  readonly requires?: AuthSpec;
  readonly source: SkillSource;
}

/** 注册时把 descriptor 和 handler 配对。handler 不进 Skill 本体，便于 Skill 序列化。 */
export interface SkillBundle {
  readonly skill: Skill;
  readonly handlers: ReadonlyMap<string, ToolHandler>;
}

export type Health =
  | { readonly status: 'up' }
  | { readonly status: 'degraded'; readonly reason: string }
  | { readonly status: 'down'; readonly reason: string };

/**
 * 动态 skill 来源。MCP 适配器实现这个接口。
 * 框架不认识 MCP —— 它只认识 SkillProvider，所以换协议不动内核。
 */
export interface SkillProvider {
  readonly id: string;
  list(): Promise<readonly SkillBundle[]>;
  health(): Promise<Health>;
  /** 上游 skill 集变化时通知。返回取消订阅函数。 */
  onChange?(cb: () => void): () => void;
  close?(): Promise<void>;
}

/**
 * 任务启动时对可用工具集做的快照。
 * **必须钉住版本**：否则 MCP server 中途更新会让同一个 toolId 含义改变，事件日志就不可重放了。
 */
export interface ToolsetSnapshot {
  readonly takenAt: number;
  readonly skills: readonly { readonly id: SkillId; readonly version: string }[];
}

/** 某个 Agent 被授予了哪些 skill（对应 Agent 编辑器里的工具开关）。 */
export interface SkillGrant {
  readonly agentId: AgentId;
  readonly skillId: SkillId;
  readonly enabled: boolean;
}
