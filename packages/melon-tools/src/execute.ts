import type { ToolContext, ToolHandler, ToolOutput } from '@melon-ai/core';
import { CircuitBreaker } from './breaker.js';
import { CircuitOpenError, TimeoutError, isRetriable, toToolError } from './errors.js';

export interface ExecuteConfig {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** 退避基数，实际延迟 = base * 2^attempt。 */
  readonly backoffBaseMs: number;
}

export const DEFAULT_EXECUTE: ExecuteConfig = { timeoutMs: 30_000, maxRetries: 2, backoffBaseMs: 200 };

export interface ExecuteDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly breaker: CircuitBreaker;
}

export interface ExecuteResult {
  readonly output?: ToolOutput;
  readonly error?: ReturnType<typeof toToolError>;
  readonly retries: number;
  readonly ms: number;
}

/** 在 handler 的 signal 之外再叠一层超时，两者任一触发都中止。 */
async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort(outer.reason);
  if (outer.aborted) ctl.abort(outer.reason);
  else outer.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => ctl.abort(new TimeoutError(timeoutMs)), timeoutMs);
  try {
    return await Promise.race([
      fn(ctl.signal),
      new Promise<never>((_, rej) => {
        ctl.signal.addEventListener('abort', () => {
          rej(ctl.signal.reason instanceof Error ? ctl.signal.reason : new TimeoutError(timeoutMs));
        }, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onAbort);
  }
}

/**
 * 执行段：超时 + 中止 + **分类重试** + 每工具熔断。
 *
 * 分类重试是关键：只有 `UPSTREAM` 和 `RATE_LIMITED` 重试。
 * 无脑重试 `DENIED` 或 `INVALID_ARGS` 是在烧步数预算，而且必然失败。
 */
export async function execute(
  toolId: string,
  handler: ToolHandler,
  args: unknown,
  cx: ToolContext,
  cfg: ExecuteConfig,
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const started = deps.now();
  const blockedUntil = deps.breaker.check(toolId, started);
  if (blockedUntil !== null) {
    return {
      error: toToolError(new CircuitOpenError(toolId, blockedUntil)),
      retries: 0,
      ms: 0,
    };
  }

  let retries = 0;
  for (;;) {
    try {
      // 每次尝试都给 handler 一个新的 signal：上一次超时中止的 signal 不能复用
      const output = await withTimeout(
        (signal) => handler(args, { ...cx, signal }),
        cx.signal,
        cfg.timeoutMs,
      );
      deps.breaker.onSuccess(toolId);
      return { output, retries, ms: deps.now() - started };
    } catch (e) {
      const err = toToolError(e);
      deps.breaker.onFailure(toolId, deps.now());
      if (!isRetriable(err.code) || retries >= cfg.maxRetries || cx.signal.aborted) {
        return { error: err, retries, ms: deps.now() - started };
      }
      await deps.sleep(cfg.backoffBaseMs * 2 ** retries);
      retries += 1;
    }
  }
}
