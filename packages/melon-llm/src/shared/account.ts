import { ToolError } from '@melon-ai/core';

/** 余额不足、欠费、资源包用完：各家说法不一，有的还用 429（看着像限流）。真正的限流（requests per minute）不在这里。 */
const BILLING = /余额不足|欠费|资源包|充值|insufficient[_ ](balance|quota|funds|credit)|credit balance is too low|exceeded your current quota|payment required|billing|arrearage|account.*(suspended|deactivated)/i;
const AUTH = /鉴权失败|invalid[_ ]api[_ ]key|incorrect api key|unauthori[sz]ed|authentication|api key 无效/i;

/**
 * 这是「这家账户现在用不了」的错误吗（换同一家的别的模型也没用）：
 * `billing` 余额不足 / 欠费；`auth` key 不对、被吊销。不是返回 null。
 */
export function isAccountError(e: unknown): 'billing' | 'auth' | null {
  const msg = String((e as { message?: string })?.message ?? e ?? '');
  const status = /\b(402|401)\b/.exec(msg)?.[1];
  if (status === '402' || BILLING.test(msg)) return 'billing';
  if (status === '401' || AUTH.test(msg)) return 'auth';
  return null;
}


/**
 * 适配器用：余额不足不再报成「触发限流」—— 智谱的余额不足是 429，看着像限流，
 * 用户看到「限流」会以为等一会儿就好。返回 null 表示不是账户问题，按原来的分类走。
 */
export function billingError(status: number, message: string): ToolError | null {
  if (status !== 402 && isAccountError(message) !== 'billing') return null;
  return new ToolError('FATAL', `余额不足（${status}）：${message}`, { retriable: false, hint: '去这家的控制台充值，或在设置里先停用它' });
}
