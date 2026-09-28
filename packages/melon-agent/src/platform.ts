import { createHash, randomUUID } from 'node:crypto';
import type {
  Clock, Hasher, IdGen, LogField, LogLevel, Logger, Platform, Span, SpanKind, SpanStatus,
  TraceContext, TraceId, Tracer,
} from '@melon-ai/core';
import { asSpanId, asTraceId } from '@melon-ai/core';

/**
 * Node 平台实现。
 *
 * **刻意不做默认值**：`createAgent` 要求显式传 `platform`。
 * 因为默认使用 `node:crypto` 会让 `@melon-ai/agent` 变成 Node 专属，
 * 而框架承诺宿主无关（§2.8）。浏览器宿主传自己的实现即可。
 */
export const systemClock: Clock = { now: () => Date.now() };

export const uuidIds: IdGen = { next: (prefix = 'id') => `${prefix}-${randomUUID()}` };

export const nodeHasher: Hasher = {
  sha256: (input) => createHash('sha256').update(input, 'utf8').digest('hex'),
};

export interface ConsoleLoggerOptions {
  readonly min?: LogLevel;
  readonly sink?: (line: string) => void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function consoleLogger(opts: ConsoleLoggerOptions = {}): Logger {
  const min = ORDER[opts.min ?? 'info'];
  const sink = opts.sink ?? ((l: string) => { process.stderr.write(`${l}\n`); });
  const make = (bound: Readonly<Record<string, LogField>>): Logger => ({
    log(level, msg, fields = {}) {
      if (ORDER[level] < min) return;
      const all = { ...bound, ...fields };
      const tail = Object.keys(all).length > 0 ? ` ${JSON.stringify(all)}` : '';
      sink(`[${level}] ${msg}${tail}`);
    },
    child(fields) { return make({ ...bound, ...fields }); },
  });
  return make({});
}

/** 只写日志的 tracer。接 OpenTelemetry 只需另做一个实现，内核不动。 */
export function loggingTracer(logger: Logger, ids: IdGen): Tracer {
  const mk = (): TraceContext => ({
    traceId: asTraceId(ids.next('trace')), spanId: asSpanId(ids.next('span')),
  });
  return {
    root(replayOf?: TraceId) {
      const base = mk();
      return replayOf !== undefined ? { ...base, replayOf } : base;
    },
    child(parent) {
      return {
        traceId: parent.traceId,
        spanId: asSpanId(ids.next('span')),
        parentSpanId: parent.spanId,
        ...(parent.replayOf !== undefined ? { replayOf: parent.replayOf } : {}),
      };
    },
    startSpan(name: string, kind: SpanKind, parent: TraceContext): Span {
      const ctx = this.child(parent);
      const started = Date.now();
      const attrs: Record<string, string | number | boolean> = {};
      return {
        ctx,
        setAttr: (k, v) => { attrs[k] = v; },
        end: (status?: SpanStatus) => {
          logger.log('debug', `span ${name}`, {
            kind, traceId: ctx.traceId, spanId: ctx.spanId,
            ms: Date.now() - started, ok: status?.ok ?? true, ...attrs,
          });
        },
      };
    },
  };
}

/** 一次性拿到 Node 上的全套平台实现。 */
export function nodePlatform(opts: ConsoleLoggerOptions = {}): Platform {
  const logger = consoleLogger(opts);
  return {
    clock: systemClock,
    ids: uuidIds,
    logger,
    hasher: nodeHasher,
    tracer: loggingTracer(logger, uuidIds),
  };
}
