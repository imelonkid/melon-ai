import type { ThinkingLevel } from './model.js';
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

/**
 * 一个定制 Agent：自己的说明书（人设与做事规则）、能用哪些技能。宿主按用户的配置给（Agent 编辑页、导入的 Agent 包）。
 *
 * - `instructions` 进这个 Agent 每个任务的上下文（在宿主的说明之前、不压缩）。
 * - `skills`：能用的技能 id（工具 id 点号前那段，如 `web`、`image`）；不给表示不限。
 *   引擎自己的基础工具（读完整内容、技能查找、记忆……，技能 id 为 `builtin` / `artifact`）总是在。
 *   不在名单里的工具：模型看不到，硬调也在准入第一道闸被拒。
 * 没有定义的 Agent（默认的那个）不受限。
 */
export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly instructions?: string;
  readonly skills?: readonly string[];
  /** 思考力度：这个 Agent 默认想多少（写作类的通常 `off`）；任务自己给了的以任务为准；不填用模型的默认。 */
  readonly thinking?: ThinkingLevel | 'auto';
}
