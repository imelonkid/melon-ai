import type { Health } from './skill.js';

/**
 * ─── 触发源 ───
 * Agent 的三种触发方式（手动 / 定时 / 事件）里，事件触发需要一个外部事件源抽象。
 * cron 由 melon-trigger 内置实现；外部事件源（邮件到达、消息关键词命中）做成适配器。
 */
export interface TriggerEvent {
  readonly sourceId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly at: number;
  /** 去重键。同一外部事件重复投递时应当只触发一次。 */
  readonly dedupeKey?: string;
}

export interface TriggerSource {
  readonly id: string;
  start(emit: (e: TriggerEvent) => void): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<Health>;
}
