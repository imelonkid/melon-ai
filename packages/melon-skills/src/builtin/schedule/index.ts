import type { SkillProvider, Task } from '@melon-ai/core';
import { defineSkill, defineTool } from '../../registry/define.js';

/**
 * 「什么时候跑」。与引擎 trigger 的 `When` 同形（这里不能依赖 engine，只描述形状）；
 * 多一个 `now` 表示立即跑一次。
 */
export type ProposedWhen =
  | { readonly repeat: 'now' }
  | { readonly repeat: 'once'; readonly at: string }
  | { readonly repeat: 'daily' | 'workdays'; readonly time: string }
  | { readonly repeat: 'weekly'; readonly days: readonly number[]; readonly time: string };

export interface ProposeArgs {
  readonly goal: string;
  readonly repeat: 'now' | 'once' | 'daily' | 'workdays' | 'weekly';
  readonly date?: string;
  readonly time?: string;
  readonly days?: readonly number[];
}

/**
 * 模型填的参数 → `ProposedWhen`。只管形状；时间是否合法（过去的时刻、没选星期）由 `check` 判。
 * 模型给的是日期字符串而不是时间戳 —— 让模型算毫秒数既容易错又没必要。
 */
export function proposalToWhen(a: ProposeArgs): { ok: true; when: ProposedWhen } | { ok: false; error: string } {
  switch (a?.repeat) {
    case 'now':
      return { ok: true, when: { repeat: 'now' } };
    case 'once':
      if (!a.date || !a.time) return { ok: false, error: '一次性任务需要 date（YYYY-MM-DD）和 time（HH:MM）' };
      return { ok: true, when: { repeat: 'once', at: `${a.date} ${a.time}` } };
    case 'daily':
    case 'workdays':
      if (!a.time) return { ok: false, error: '需要 time（HH:MM）' };
      return { ok: true, when: { repeat: a.repeat, time: a.time } };
    case 'weekly':
      if (!a.time) return { ok: false, error: '需要 time（HH:MM）' };
      return { ok: true, when: { repeat: 'weekly', days: a.days ?? [], time: a.time } };
    default:
      return { ok: false, error: 'repeat 只能是 now / once / daily / workdays / weekly' };
  }
}

export interface ScheduleSkillOptions {
  /** 校验「什么时候」是否合法。由组装层注入引擎的 `whenToRule`（技能包不依赖引擎）。 */
  readonly check: (when: ProposedWhen) => { ok: true } | { ok: false; error: string };
  /**
   * 哪些任务里提供这个工具。默认：不是定时触发的任务 ——
   * 定时触发时没人在屏幕前确认草稿，给了它只会空转。宿主可以收得更窄（比如只在对话里）。
   */
  readonly when?: (task: Task) => boolean;
}

/**
 * 内置技能：拟定时任务草稿。
 *
 * **只产出草稿，不建任务** —— 真正建要用户确认。草稿不存在这里：
 * 宿主从事件日志里这次调用的参数还原出卡片（用 `proposalToWhen`），用户点确认后调 `schedules.create`。
 * 所以它没有副作用，风险是 read，不需要审批。
 */
export function schedule(opts: ScheduleSkillOptions): SkillProvider {
  const propose = defineTool<ProposeArgs>({
    id: 'schedule.propose',
    description:
      '当用户想让你稍后、定期或者作为一项独立任务去做某件事时，用它拟一个任务草稿给用户确认。'
      + '调用前先把「做什么」和「什么时候」问清楚。草稿只是给用户看，用户确认后才会创建；不要自己直接去执行那件事。',
    input: {
      goal: { type: 'string', description: '到点后 Agent 要做的事，写清楚对象和产出。不要包含时间。' },
      repeat: {
        type: 'string',
        enum: ['now', 'once', 'daily', 'workdays', 'weekly'],
        description: 'now=立即运行一次；once=指定时间运行一次；daily=每天；workdays=周一到周五；weekly=每周指定几天',
      },
      date: { type: 'string', optional: true, description: 'repeat=once 时必填，YYYY-MM-DD' },
      time: { type: 'string', optional: true, description: 'repeat 不是 now 时必填，HH:MM，24 小时制' },
      days: {
        type: 'integer[]', optional: true, minimum: 0, maximum: 6,
        description: 'repeat=weekly 时必填，0=周日 1=周一 … 6=周六',
      },
    },
    when: opts.when ?? ((task) => task.trigger.type !== 'schedule'),
    run(args) {
      const shaped = proposalToWhen(args);
      const checked = shaped.ok ? opts.check(shaped.when) : shaped;
      // 参数不对就把原因告诉模型，让它改了再提 —— 不给用户看一张建不出来的卡
      if (!checked.ok) return `草稿无效：${checked.error}。请修正后重新提议。`;
      return '任务草稿已展示给用户，等用户确认创建。用一句话告诉用户草稿拟好了即可，不要重复提议。';
    },
  });
  return defineSkill({
    id: 'schedule',
    name: '定时任务',
    purpose: '用户想让你稍后、定期或作为独立任务去做某件事时使用',
    tools: [propose],
    builtin: true,
  });
}
