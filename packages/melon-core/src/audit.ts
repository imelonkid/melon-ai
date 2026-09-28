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

/**
 * 资源引用。**日志只存这个，不内联 payload**（见 docs/architecture.md §2.4）。
 */
export interface ResourceRef {
  readonly kind: string;
  readonly ref: string;
  /**
   * 被引用负载的内容哈希。
   *
   * 少了它，哈希链只能证明「这条记录没被改」，**不能**证明「被引用的东西还是当初那个」——
   * 能写主库的人可以事后替换 payload 而审计链毫无察觉，防篡改形同虚设。
   *
   * 哈希不可逆、不含 PII，所以不影响可删除性。
   */
  readonly contentHash?: string;
}

/**
 * payload 被删除后留下的墓碑。
 * 让解引用能区分「从未存在」（可能是数据损坏）与「已被删除」（正常隐私操作）。
 */
export interface ResourceTombstone {
  readonly kind: string;
  readonly ref: string;
  readonly deletedAt: number;
  readonly reason: 'user-request' | 'retention' | 'privacy-optout';
}

export type ResolvedResource =
  /** contentHashMatches=false 意味着负载在记录之后被改动过 —— 这是需要告警的情况。 */
  | { readonly status: 'ok'; readonly payload: unknown; readonly contentHashMatches: boolean }
  | { readonly status: 'deleted'; readonly tombstone: ResourceTombstone }
  | { readonly status: 'missing' };

/**
 * 解引用。
 * **批量是必需的，不是优化** —— 渲染 500 条日志不能退化成 500 次查询。
 */
export interface ResourceResolver {
  resolve(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, ResolvedResource>>;
}

export interface AuditRecord {
  readonly seq: number;
  readonly at: number;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  /** 被作用的资源。只存引用，见 ResourceRef。 */
  readonly resource: ResourceRef;
  readonly outcome: AuditOutcome;
  /**
   * 非敏感的维度字段。**这是「引用优先」的必要配套，不是可选项**：
   *
   * 1. 常见查询（「上个月对外发了多少封邮件」）必须能只靠日志回答，不解引用；
   * 2. payload 被删除后，这些维度让记录仍然有意义 ——
   *    仍能证明「这件事发生过」，只是不再知道「对什么」。
   *
   * 只放计数、类型、枚举。**不放内容。**
   */
  readonly dimensions?: Readonly<Record<string, string | number | boolean>>;
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

/**
 * 保留策略。
 * **约束：被审计资源的 payload 保留期必须 ≥ 审计保留期**，
 * 否则审计轨迹大部分解不开（见 §2.4 坑三）。这条由实现方在启动时校验并拒绝非法配置。
 */
export interface RetentionPolicy {
  readonly auditDays: number;
  readonly payloadDays: number;
  /** 这些动作的审计记录不随保留期清理。 */
  readonly keepForever: readonly AuditAction[];
}
