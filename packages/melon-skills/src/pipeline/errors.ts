import type { ToolErrorCode, ToolErrorShape } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';

/** 只有这两类自动重试。其余重试都是在烧预算。 */
export const RETRIABLE: readonly ToolErrorCode[] = ['UPSTREAM', 'RATE_LIMITED'];

/**
 * `INVALID_ARGS` 是**可修复**错误：回喂给模型让它改参，
 * 且**不计入重试次数** —— 模型改参是有进展的，不该被当成重试浪费。
 */
export const isRepairable = (code: ToolErrorCode): boolean => code === 'INVALID_ARGS';

export const isRetriable = (code: ToolErrorCode): boolean => RETRIABLE.includes(code);

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`工具执行超过 ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly toolId: string, readonly until: number) {
    super(`${toolId} 的熔断器已打开，${new Date(until).toISOString()} 前不再尝试`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * 把任意异常归一成对模型可操作的错误。
 *
 * 笼统的 `"something went wrong"` 会让模型反复重试必然失败的调用、烧光步数预算 ——
 * 所以这里宁可猜一个具体码，也不留模糊。
 */
export function toToolError(e: unknown): ToolErrorShape {
  if (e instanceof ToolError) {
    return e.hint === undefined
      ? { code: e.code, message: e.message, retriable: e.retriable }
      : { code: e.code, message: e.message, retriable: e.retriable, hint: e.hint };
  }
  if (e instanceof TimeoutError) {
    return { code: 'UPSTREAM', message: e.message, retriable: true, hint: '可以重试，或缩小请求范围' };
  }
  if (e instanceof CircuitOpenError) {
    return { code: 'UPSTREAM', message: e.message, retriable: false, hint: '这个工具暂时不可用，换别的方法' };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { code: 'FATAL', message: msg, retriable: false, hint: '放弃这条路，重新规划' };
}
