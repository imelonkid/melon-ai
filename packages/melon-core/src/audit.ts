import type { TaskId } from './ids.js';

/**
 * ─── 审计 ───
 * 与 EventLog 是**两件不同的东西**，不要合并。理由见 docs/architecture.md §4.5。
 * EventLog 为可重放服务，按 taskId 分片；审计为合规与追责服务，按主体/资源/时间查询。
 */

export type AuditActorKind = 'user' | 'agent' | 'system';

export interface AuditActor {
  readonly kind: AuditActorKind;
  readonly id: string;
}

export type AuditAction =
  | 'tool.invoke'        // 工具调用，external / spend / irreversible 一律记
  | 'approval.decide'    // 审批决策，**必须带 basis**
  | 'memory.write'       // L1 写入
  | 'memory.recall'      // L1 召回 —— 隐私合规的核心，EventLog 不覆盖
  | 'skill.register'     // 新技能进入系统，这是安全事件
  | 'skill.unregister'
  | 'policy.change'
  | 'model.route';       // 数据发往了哪个供应商（数据出境合规）

export type AuditOutcome = 'allow' | 'ask' | 'deny' | 'ok' | 'error';

export interface AuditRecord {
  readonly seq: number;
  readonly at: number;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  /**
   * 被作用的资源。**存引用，不存 payload。**
   * 否则审计库会变成敏感数据的第二份副本，反而扩大暴露面。
   */
  readonly resource: { readonly kind: string; readonly ref: string };
  readonly outcome: AuditOutcome;
  /**
   * 决策**依据**：命中的 grant、当时的 PolicyMode、匹配的配额、选中的供应商。
   * 这是事后举证的关键 —— EventLog 缺的正是这一块。
   */
  readonly basis?: Readonly<Record<string, string | number | boolean>>;
  readonly taskId?: TaskId;
  /** 把一次用户意图下的所有记录串起来，跨任务追踪。 */
  readonly correlationId: string;
  /** 前一条记录的哈希，构成防篡改链。 */
  readonly prevHash?: string;
  readonly hash: string;
}

/** 写入时不需要调用方提供 seq / prevHash / hash —— 由 melon-audit 补齐。 */
export type AuditDraft = Omit<AuditRecord, 'seq' | 'prevHash' | 'hash'>;

export interface AuditQuery {
  readonly actor?: AuditActor;
  readonly actions?: readonly AuditAction[];
  readonly resourceKind?: string;
  readonly resourceRef?: string;
  readonly taskId?: TaskId;
  readonly correlationId?: string;
  readonly from?: number;
  readonly to?: number;
  readonly limit: number;
}

/** 领域模块调这个。实现在 melon-audit（负责哈希链、脱敏、关联 id）。 */
export interface AuditRecorder {
  record(draft: AuditDraft): Promise<void>;
}

/** 持久化端口。实现在 melon-store-*。 */
export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
  query(q: AuditQuery): Promise<readonly AuditRecord[]>;
  lastHash(): Promise<string | undefined>;
  /** 按保留期清理。keep 里的动作类型不清 —— 审计保留期可以长于任务本身。 */
  prune(before: number, keep: readonly AuditAction[]): Promise<number>;
  /** 校验哈希链完整性。返回第一处断裂的 seq，完整则返回 null。 */
  verify(fromSeq?: number): Promise<number | null>;
}
