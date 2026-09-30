import type { Recurrence, TimeOfDay, Weekday } from '@melon-ai/core';
import { resolveLocal } from './recurrence.js';

/**
 * 「什么时候跑」的宿主友好写法。
 *
 * `Recurrence` 是引擎内部的精确表示（带时区、时刻拆成时与分）；宿主和模型更愿意写
 * 「每周五 16:00」「2026-10-02 09:00」。这里做两者的换算，宿主不必各自实现一遍。
 *
 * ```ts
 * { repeat: 'once', at: '2026-10-02 09:00' }   // 或时间戳
 * { repeat: 'daily', time: '09:00' }
 * { repeat: 'workdays', time: '09:00' }        // 周一到周五
 * { repeat: 'weekly', days: [5], time: '16:00' } // 0=周日 … 6=周六
 * { repeat: 'interval', everyMinutes: 15 }
 * ```
 */
export type When =
  | { readonly repeat: 'once'; readonly at: number | string }
  | { readonly repeat: 'daily'; readonly time: string }
  | { readonly repeat: 'workdays'; readonly time: string }
  | { readonly repeat: 'weekly'; readonly days: readonly number[]; readonly time: string }
  | { readonly repeat: 'interval'; readonly everyMinutes: number };

export interface WhenOptions {
  /** 默认宿主系统时区 —— 单机应用里「我电脑上的 9 点」就是用户要的 9 点。 */
  readonly tz?: string;
  readonly now?: number;
}

export const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const WORKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5];

/** 'HH:MM' → TimeOfDay。非法返回 null。 */
function parseTime(s: string): TimeOfDay | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour > 23 || minute > 59 ? null : { hour, minute };
}

/** 'YYYY-MM-DD HH:MM'（也接受 T 分隔）按目标时区 → 时间戳。 */
function parseLocal(s: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const t = parseTime(`${m[4]}:${m[5]}`);
  return t ? resolveLocal(tz, Number(m[1]), Number(m[2]), Number(m[3]), t) : null;
}

export type WhenResult = { readonly ok: true; readonly rule: Recurrence } | { readonly ok: false; readonly error: string };

/**
 * 友好写法 → 引擎的周期规则。校验失败返回原因而不是抛错 —— 通常是用户或模型填错了，
 * 要把原因原样告诉他们。
 */
export function whenToRule(when: When, opts: WhenOptions = {}): WhenResult {
  const tz = opts.tz ?? hostTimeZone();
  const now = opts.now ?? Date.now();
  switch (when?.repeat) {
    case 'once': {
      const at = typeof when.at === 'number' ? when.at : parseLocal(when.at, tz);
      if (at === null || !Number.isFinite(at)) return { ok: false, error: '运行时间要写成 YYYY-MM-DD HH:MM 或时间戳' };
      // 过去的时刻建出来也永远不会跑 —— 在入口拦住
      if (at <= now) return { ok: false, error: '这个时间已经过了' };
      return { ok: true, rule: { kind: 'once', at } };
    }
    case 'daily':
    case 'workdays':
    case 'weekly': {
      const time = parseTime(when.time);
      if (!time) return { ok: false, error: '时间要写成 HH:MM' };
      if (when.repeat === 'daily') return { ok: true, rule: { kind: 'daily', time, tz } };
      const days = when.repeat === 'workdays'
        ? WORKDAYS
        : ([...new Set(when.days.map(Number))].filter((d) => d >= 0 && d <= 6).sort() as Weekday[]);
      if (days.length === 0) return { ok: false, error: '至少选一天' };
      return { ok: true, rule: { kind: 'weekly', days, time, tz } };
    }
    case 'interval': {
      const n = Number(when.everyMinutes);
      if (!(n >= 1)) return { ok: false, error: '间隔至少 1 分钟' };
      return { ok: true, rule: { kind: 'interval', everyMs: Math.round(n * 60_000) } };
    }
    default:
      return { ok: false, error: '不认识的重复方式' };
  }
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * 周期规则 → 一句话：「每个工作日 09:00」「每周五 16:00」「仅一次 · 10月2日 09:00」。
 * 一次性的日期按规则所在时区（没有则宿主时区）显示。
 */
export interface DescribeOptions {
  /** 一次性的只写时刻（「10月2日 09:00」），不带「仅一次 · 」—— 列表里已经按一次性归好类时用。 */
  readonly bare?: boolean;
}

export function describeRule(rule: Recurrence, tz: string = hostTimeZone(), opts: DescribeOptions = {}): string {
  const hm = (t: TimeOfDay) => `${pad(t.hour)}:${pad(t.minute)}`;
  switch (rule.kind) {
    case 'once': {
      const p = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }).formatToParts(new Date(rule.at));
      const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
      const at = `${get('month')}月${get('day')}日 ${pad(get('hour') % 24)}:${pad(get('minute'))}`;
      return opts.bare ? at : `仅一次 · ${at}`;
    }
    case 'daily':
      return `每天 ${hm(rule.time)}`;
    case 'weekly': {
      const days = [...rule.days].sort();
      if (days.join() === WORKDAYS.join()) return `每个工作日 ${hm(rule.time)}`;
      if (days.length === 7) return `每天 ${hm(rule.time)}`;
      // 周日排最后，符合中文习惯
      const order = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)];
      return `每${order.map((d) => WEEKDAY[d]).join('、')} ${hm(rule.time)}`;
    }
    case 'interval': {
      const min = Math.round(rule.everyMs / 60_000);
      return min >= 60 && min % 60 === 0 ? `每 ${min / 60} 小时` : `每 ${min} 分钟`;
    }
  }
}
