import type { ResourceRef, ResourceTombstone } from './audit.js';

/**
 * ─── 删除 ───
 * 不做全局「软删 / 硬删」二选一。动因不同，正确做法不同。
 * 详见 docs/architecture.md §2.5。
 */
export type DeletionMotive =
  /**
   * 纠正或替代：记忆冲突、Agent 配置变更。
   * → **版本链**，不物理删。要能回答「你为什么以为我喜欢 X」并撤销。
   */
  | 'supersede'
  /**
   * 运维清理：保留期到期、回收空间。
   * → 归档后物理删。留着没价值，只有成本和风险。
   */
  | 'retention'
  /**
   * 用户要求遗忘 / 隐私撤回。
   * → **必须物理删除负载并留墓碑**。
   *
   * 这是唯一不能让的例外：软删在这里是合规漏洞，不是保守做法。
   * §2.4「引用优先于负载」的主要好处正建立在这条能真正执行之上。
   */
  | 'privacy';

/** 只有 retention 和 privacy 走物理删；supersede 用版本链，不进这个接口。 */
export type PurgeMotive = Extract<DeletionMotive, 'retention' | 'privacy'>;

export interface PurgeRequest {
  readonly refs: readonly ResourceRef[];
  readonly motive: PurgeMotive;
  readonly reason: string;
  /**
   * 试运行：只报告将要发生什么，不实际删除。
   * privacy 类删除不可逆，调用方应当先 dryRun 再执行。
   */
  readonly dryRun?: boolean;
}

export interface PurgeResult {
  readonly tombstones: readonly ResourceTombstone[];
  /**
   * 一并物理移除的派生条目数（向量索引、FTS 行）。
   * 派生数据豁免「不物理删」原则 —— 它们可重建，留着会污染召回。
   */
  readonly derivedRemoved: number;
  readonly skipped: readonly { readonly ref: string; readonly why: string }[];
}

/**
 * 物理删除负载。
 *
 * 实现方注意：删除负载后，指向它的审计记录会变成悬垂引用 ——
 * 这是**预期行为**，靠 `AuditRecord.dimensions` 保持记录仍然有意义
 * （仍能证明「这件事发生过」，只是不再知道「对什么」）。
 */
export interface Purger {
  purge(req: PurgeRequest): Promise<PurgeResult>;
}

/**
 * 归档层。retention 类清理先归档再删，给「误删恢复」留窗口。
 * privacy 类**不经过归档** —— 否则等于没删。
 */
export interface Archive {
  archive(refs: readonly ResourceRef[]): Promise<number>;
  restore(refs: readonly ResourceRef[]): Promise<number>;
  /** 归档区自身的容量治理。桌面端 SQLite 只会变大，这一层是必需的。 */
  size(): Promise<{ readonly rows: number; readonly bytes: number }>;
}
