import type { AgentId, SkillId } from './ids.js';
import type { ToolDescriptor, ToolHandler } from './tool.js';
import type { Task } from './task.js';

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
  /**
   * 按任务决定给不给某个工具（工具 id → 条件）。不在表里的工具总是给。
   * 例：「拟定时任务」只在有人在场确认的任务里给，定时触发的任务里给了只会空转。
   */
  readonly when?: ReadonlyMap<string, (task: Task) => boolean>;
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


/** 某个 Agent 被授予了哪些 skill（对应 Agent 编辑器里的工具开关）。 */
export interface SkillGrant {
  readonly agentId: AgentId;
  readonly skillId: SkillId;
  readonly enabled: boolean;
}
