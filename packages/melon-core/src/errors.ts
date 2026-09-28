/**
 * 工具错误码。这组码是**给模型看的**：模型必须能据此决定下一步动作，
 * 所以每个码的语义要互斥且可操作。笼统的错误会让模型反复重试必然失败的调用。
 */
export type ToolErrorCode =
  /** 参数不合法 → 模型应改参重试。不计入重试次数。 */
  | 'INVALID_ARGS'
  /** 被准入层拒绝 → 模型**不应重试**，换方案或问用户。 */
  | 'DENIED'
  /** 目标不存在 → 模型应换查询条件。 */
  | 'NOT_FOUND'
  /** 触发限流 → 模型什么都别做，管线会自动退避。 */
  | 'RATE_LIMITED'
  /** 上游故障 → 可重试一次。 */
  | 'UPSTREAM'
  /** 不可恢复 → 放弃这条路，重新规划。 */
  | 'FATAL';

export interface ToolErrorShape {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retriable: boolean;
  /** 给模型的修复建议，会原样进上下文。 */
  readonly hint?: string;
}

export class ToolError extends Error implements ToolErrorShape {
  readonly code: ToolErrorCode;
  readonly retriable: boolean;
  readonly hint?: string;

  constructor(code: ToolErrorCode, message: string, opts?: { retriable?: boolean; hint?: string }) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.retriable = opts?.retriable ?? (code === 'UPSTREAM' || code === 'RATE_LIMITED');
    if (opts?.hint !== undefined) this.hint = opts.hint;
  }
}

/** 乐观并发冲突：期望的版本号与存储中的不符。调用方应重读后重试。 */
export class ConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`version conflict: expected ${expected}, got ${actual}`);
    this.name = 'ConflictError';
  }
}

/** 状态机收到了当前状态下非法的事件。这是编程错误，不是运行时异常。 */
export class IllegalTransitionError extends Error {
  constructor(readonly from: string, readonly event: string) {
    super(`illegal transition: ${from} --${event}-->`);
    this.name = 'IllegalTransitionError';
  }
}
