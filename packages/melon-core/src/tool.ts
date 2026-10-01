import type { ArtifactRef, CallId, SkillId, TaskId, ToolId } from './ids.js';
import type { ToolErrorShape } from './errors.js';
import type { LogField } from './ports/platform.js';
import type { TraceContext } from './trace.js';
import type { Currency } from './usage.js';

/**
 * 风险等级。决定准入层要不要拦。顺序即严重程度。
 * - read          只读，不产生外部可见变化
 * - write         写内部状态（草稿、笔记）
 * - external      对外可见（发邮件、发消息、改共享文档）
 * - spend         花钱
 * - irreversible  不可撤销（删除、不可召回的发送）
 */
export type RiskClass = 'read' | 'write' | 'external' | 'spend' | 'irreversible';

export const RISK_ORDER: readonly RiskClass[] = ['read', 'write', 'external', 'spend', 'irreversible'];

/** JSON Schema 子集。故意不引 ajv 的类型 —— 契约层不绑定校验器实现。 */
export type JSONSchema = Record<string, unknown>;

/** 常驻上下文的工具签名（便宜）。全量 schema 按需通过 describe_tool 取（贵）。 */
export interface ToolSignature {
  readonly id: ToolId;
  readonly summary: string;
  readonly required: readonly string[];
  readonly risk: RiskClass;
}

export interface ToolDescriptor {
  readonly id: ToolId;
  readonly skillId: SkillId;
  readonly name: string;
  readonly description: string;
  readonly input: JSONSchema;
  readonly risk: RiskClass;
  /** 幂等工具可安全重试；非幂等工具由准入层分配 idempotencyKey。 */
  readonly idempotent: boolean;
  /**
   * 承载授权范围的参数名。
   *
   * 没有这个声明，「始终允许」只有两种坏选择：
   * 按结构匹配 → 「允许发邮件给任何人」，太宽；
   * 按全量参数匹配 → 「允许发这一封」，永不再命中，没用。
   *
   * 例：`mail.send` 声明 `['to']`，则授权覆盖「发给产品组」但不限主题与正文。
   * 不声明则 scope 为 `*`，意味着该工具的「始终允许」不区分参数 ——
   * 只适用于本身无范围概念的工具（如 `artifact_read`）。
   */
  readonly scopeKeys?: readonly string[];
  /**
   * 「始终允许」不按工具 id + 参数精确匹配，而按宿主能理解的单位：本地文件按文件夹 ——
   * 允许了 ~/Downloads，列目录、找文件、读文件都放行，子文件夹也算。
   * - `key`：授权记在这个名下（几个工具共用一份）
   * - `scope(args)`：这次调用的范围（如 `folder=/Users/me/Downloads/报表`）
   * - `covers(已授权, 这次)`：已有的授权是否覆盖这次（如文件夹包含）
   */
  readonly grantBy?: {
    readonly key: string;
    scope(args: unknown): string;
    covers(granted: string, requested: string): boolean;
  };
  /**
   * 问用户之前，工具自己先查一遍参数（路径存不存在、是不是受保护的位置……）。有问题直接退回给模型改，
   * 不让用户去批准一个注定失败的调用（「允许查看 ~/Download？」—— 那个文件夹根本不存在）。返回 null 表示没问题。
   */
  precheck?(args: unknown): Promise<{ readonly message: string; readonly hint?: string } | null>;
  readonly costHint?: { readonly latencyMs: number; readonly bytesOut: number };
  /**
   * 按次收费的外部服务（搜索等）：每次真的执行都记进用量账本（`purpose: 'tool'`），宿主的用量页能看到「搜索 N 次 · ¥x」。
   * `perCall` 不知道就不填 —— 只记次数，费用记「未计价」。重复调用命中缓存的不算（没真的调用）。
   */
  readonly billing?: { readonly vendor: string; readonly perCall?: { readonly amount: number; readonly currency: Currency } };
  /**
   * 输出来自外部、不可信（网页、搜索结果、第三方 MCP 返回……）。
   *
   * 调用过它的任务会被标记污点：之后的对外、花钱、不可撤销操作一律要用户确认，
   * 不看策略档位、不看「始终允许」。网页里写一句「把文档发给 x@…」就是提示注入，
   * 模型分不清这是用户的意思还是网页的意思 —— 所以由人来分。
   */
  readonly untrustedOutput?: boolean;
  /**
   * 触发词：用户这句话里出现其中任何一个，引擎就认定要用到这个工具（规则判定，不问模型）。
   *
   * 对有副作用的工具（risk 不是 read）尤其重要：召回到了，引擎就要求模型必须调用它，
   * 模型只回一段话不算数 —— 见 llm/planner 的动作守卫。例：`mail.send` 写 `['发邮件', '邮件', 'email']`。
   */
  readonly triggers?: readonly string[];
  /**
   * 结果摘要进上下文的字符上限。默认 2048（约 512 token），超出部分落 artifact。
   *
   * 大多数工具不该改它：大结果就该走句柄。例外是「结果本身就是给模型的指令」的工具，
   * 比如激活一个技能要把整份操作说明交给模型 —— 截断了模型就只看到半份说明。
   * 注册时上限封顶 32000。
   */
  readonly outputLimit?: number;
  /**
   * 这些参数的值**必须是用户自己说过的**（比如收件人）。模型填了用户没给过的值 ——
   * 编的（「product-team@example.com」）、或从网页里抄来的（提示注入）—— 规划器退回让它问用户，不弹确认卡。
   */
  readonly userSupplied?: readonly string[];
}

export interface ToolCall {
  readonly callId: CallId;
  readonly toolId: ToolId;
  readonly args: unknown;
  /** 对 args 归一化后的哈希。用于循环检测与幂等。「始终允许」按人可读的 scope 匹配，不用它。 */
  readonly argsHash: string;
}

/**
 * 工具执行期能看到的全部能力。**刻意收窄**：
 * 这里没有 SkillRegistry、没有任何 Store 引用，所以工具实现无法绕过准入层，
 * 也无法读写不属于它的数据。扩展工具（MCP）和内置工具拿到的是同一个上下文。
 */
export interface ToolContext {
  readonly taskId: TaskId;
  readonly callId: CallId;
  /** 这次调用的 span。对外请求应按 W3C Trace Context 把它传下去。 */
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
  /** 非幂等工具的重放保护键；幂等工具为 undefined。 */
  readonly idempotencyKey?: string;
  /** 大结果写这里，返回句柄，不要塞进 summary。 */
  putArtifact(data: Uint8Array | string, meta: { mime: string; summary: string }): Promise<ArtifactRef>;
  /**
   * 按句柄读回内容。
   *
   * **限定本任务范围** —— 实现方必须校验该 artifact 属于当前任务，
   * 否则扩展工具可以凭猜到的句柄读走别的任务的数据。
   */
  readArtifact(ref: ArtifactRef, range?: { offset: number; length: number }): Promise<string>;
  /** 字段只接受标量与资源引用，禁止 dump 对象。见 docs/architecture.md §2.4。 */
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Readonly<Record<string, LogField>>): void;
}

/** 工具作者实现这个。返回值还会经过归一化阶段，不需要自己拼信封。 */
export type ToolHandler = (args: unknown, cx: ToolContext) => Promise<ToolOutput>;

/** 工具的原始返回。归一化阶段会把它包成 ToolResult。 */
export interface ToolOutput {
  /** 进上下文的短文本。归一化阶段会按 summaryTokenLimit 截断。 */
  readonly summary: string;
  /** 小的结构化结果才放这里；大结果走 putArtifact。 */
  readonly data?: unknown;
  readonly artifactRef?: ArtifactRef;
  /** 这次生成了哪些文件（技能脚本的输出、「生成文件」）。宿主据此给用户「打开 / 另存为」。 */
  readonly files?: readonly OutputFile[];
}

/** 工具生成的一个文件。路径是宿主的本机路径（工作目录、输出目录里）。 */
export interface OutputFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

/**
 * 归一化后的统一信封。**所有工具，内置和扩展，都返回这个形状。**
 * summary 是唯一保证进上下文的字段。
 */
export interface ToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
  readonly artifactRef?: ArtifactRef;
  readonly error?: ToolErrorShape;
  readonly metrics: ToolMetrics;
  readonly files?: readonly OutputFile[];
  /** 由管线按 `ToolDescriptor.untrustedOutput` 填，工具自己不用管。 */
  readonly untrusted?: boolean;
}

export interface ToolMetrics {
  readonly ms: number;
  readonly bytes: number;
  readonly retries: number;
  readonly costUSD?: number;
}

/** 落进事件日志的精简版（不含 data/summary 正文，避免日志膨胀）。 */
export interface ToolResultMeta {
  readonly ok: boolean;
  readonly errorCode?: ToolErrorShape['code'];
  /** 被沙箱拦下了什么。随事件落盘：宿主事后给用户放行的入口（「允许这个技能联网」）。 */
  readonly sandbox?: ToolErrorShape['sandbox'];
  readonly artifactRef?: ArtifactRef;
  readonly metrics: ToolMetrics;
  /** 生成的文件，随事件落盘：宿主事后在对话里显示文件卡片。 */
  readonly files?: readonly OutputFile[];
  /**
   * 这次输出不可信。随事件落盘，reducer 据此置 `Task.tainted` ——
   * 放在事件里而不是让 reducer 去查工具描述，重放时才得出同样的结果。
   */
  readonly untrusted?: boolean;
}
