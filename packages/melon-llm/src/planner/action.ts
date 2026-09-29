import type { ModelTool } from '@melon-ai/core';

/**
 * 动作守卫：**有副作用的事做没做，由规则判定，不由模型说了算**。
 *
 * 实测（DeepSeek）的三种失败，都不是准入拦不住，而是模型根本没去调工具：
 * - 用户说「发邮件给产品组」，模型写一段「请确认收件人」就把任务结束了 —— 界面显示「已完成」，邮件没发；
 * - 用户补了一句邮箱，模型直接回「邮件已发送」—— 什么都没调，是编的；
 * - 定时任务到点跑，模型同样用文字「征求确认」—— 没人回答，周报永远发不出去。
 *
 * 所以：
 * 1. 用户的话命中某个有副作用工具的**触发词** → 要求模型必须调用工具（`toolChoice: required`）；
 * 2. 话里有**动作词**（发送、删除、付款……）却没有任何工具能做 → 不问模型，直接说没有合适的工具；
 * 3. 答复里**声称做成了**（已发送、已删除……），本任务却没有成功执行过任何有副作用的工具
 *    → 纠正一次；还这样就以失败收尾，不让编造的结果显示成「已完成」。
 *
 * 纯问答不含动作词，照常让模型回答。
 */

/** 通用动作词。宿主可以扩充（`createAgent({ actionWords })`）。 */
export const DEFAULT_ACTION_WORDS: readonly string[] = [
  '发送', '发给', '发邮件', '发短信', '发消息', '转发', '回复邮件',
  '删除', '删掉', '清空', '移除',
  '付款', '支付', '转账', '汇款', '下单', '购买', '预订', '订票',
  '发布', '上传', '提交', '打电话', '呼叫',
  'send', 'email to', 'delete', 'remove', 'pay', 'transfer', 'purchase', 'buy', 'book', 'publish', 'upload', 'submit',
];

/** 「做成了」的说法。 */
const CLAIM = /(已|已经)(成功)?(帮你|为你|给你)?(发送|发出|发给|寄出|转发|删除|删掉|清空|发布|上传|提交|支付|付款|转账|下单|购买|预订|订好)|(发送|删除|发布|上传|提交|支付|付款|转账|下单|预订)(已)?(成功|完成)|\b(has been|have been|was|were)\s+(sent|deleted|published|uploaded|submitted|paid|transferred|booked)\b|\bsuccessfully\s+(sent|deleted|published|uploaded|submitted|paid|booked)\b/i;

const lower = (s: string): string => s.toLowerCase();

/**
 * 词是否出现在话里。中文按子串；拉丁字母按整词 —— 否则 book 会命中 notebook、pay 会命中 display。
 */
function contains(text: string, word: string): boolean {
  const w = lower(word).trim();
  if (!w) return false;
  if (!/^[\x20-\x7e]+$/.test(w)) return text.includes(w);
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

/** 有副作用的工具（风险不是 read）。没有声明风险的按有副作用算 —— 宁可多管。 */
export const isActionTool = (t: ModelTool): boolean => t.risk !== 'read';

/** 用户的话命中了哪些有副作用工具的触发词。 */
export function matchActionTools(text: string, tools: readonly ModelTool[]): readonly ModelTool[] {
  const t = lower(text);
  return tools.filter((tool) => isActionTool(tool) && (tool.triggers ?? []).some((w) => contains(t, w)));
}

/** 话里的动作词（第一个命中的），没有则 null。 */
export function mentionsAction(text: string, words: readonly string[]): string | null {
  const t = lower(text);
  return words.find((w) => contains(t, w)) ?? null;
}

/** 答复里「做成了」的说法（原文片段），没有则 null。 */
export function claimsDone(answer: string): string | null {
  return CLAIM.exec(answer)?.[0] ?? null;
}

/** 给模型的纠正。以 user 角色追加 —— 规划器会丢弃上下文里的 system 消息。 */
export const correctionFor = (claim: string): string =>
  `（系统检查：你的回答里说「${claim}」，但这个任务里没有成功执行过任何对应的工具，所以这件事实际上没有做。`
  + '要做就调用工具去做；需要的信息不全就向用户问清楚；做不了就如实说明。不要声称做了没做的事。）';
