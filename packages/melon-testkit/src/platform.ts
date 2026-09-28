import type {
  Clock, IdGen, LogField, LogLevel, Logger, Platform, Span, SpanKind, SpanStatus,
  TraceContext, TraceId, Tracer,
} from '@melon-ai/core';
import { asSpanId, asTraceId } from '@melon-ai/core';

/** 可控时钟。测试里时间必须是输入，不是环境。 */
export class FakeClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now(): number { return this.t; }
  advance(ms: number): this { this.t += ms; return this; }
  set(ms: number): this { this.t = ms; return this; }
}

/** 确定性 id：同样的调用序列产生同样的 id，事件日志才能逐字节比对。 */
export class SeqIdGen implements IdGen {
  private n = 0;
  next(prefix = 'id'): string { return `${prefix}-${++this.n}`; }
  reset(): void { this.n = 0; }
}

export interface LogLine {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: Readonly<Record<string, LogField>>;
}

export class CapturingLogger implements Logger {
  readonly lines: LogLine[] = [];
  constructor(private readonly bound: Readonly<Record<string, LogField>> = {}) {}
  log(level: LogLevel, msg: string, fields: Readonly<Record<string, LogField>> = {}): void {
    this.lines.push({ level, msg, fields: { ...this.bound, ...fields } });
  }
  child(fields: Readonly<Record<string, LogField>>): Logger {
    const c = new CapturingLogger({ ...this.bound, ...fields });
    // 子 logger 写回同一个数组，断言时不必到处收集
    Object.defineProperty(c, 'lines', { value: this.lines });
    return c;
  }
  find(substr: string): LogLine[] { return this.lines.filter((l) => l.msg.includes(substr)); }
}

export interface RecordedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly ctx: TraceContext;
  readonly attrs: Record<string, string | number | boolean>;
  status?: SpanStatus;
  ended: boolean;
}

export class RecordingTracer implements Tracer {
  readonly spans: RecordedSpan[] = [];
  private n = 0;
  constructor(private readonly ids: SeqIdGen = new SeqIdGen()) {}

  root(replayOf?: TraceId): TraceContext {
    const base = { traceId: asTraceId(this.ids.next('trace')), spanId: asSpanId(this.ids.next('span')) };
    return replayOf !== undefined ? { ...base, replayOf } : base;
  }
  child(parent: TraceContext): TraceContext {
    return {
      traceId: parent.traceId,
      spanId: asSpanId(this.ids.next('span')),
      parentSpanId: parent.spanId,
      ...(parent.replayOf !== undefined ? { replayOf: parent.replayOf } : {}),
    };
  }
  startSpan(name: string, kind: SpanKind, parent: TraceContext): Span {
    const ctx = this.child(parent);
    const rec: RecordedSpan = { name, kind, ctx, attrs: {}, ended: false };
    this.spans.push(rec);
    this.n++;
    return {
      ctx,
      setAttr: (k, v) => { rec.attrs[k] = v; },
      end: (status) => { rec.ended = true; if (status) rec.status = status; },
    };
  }
  /** 断言用：所有 span 都闭合了吗。漏 end 的 span 在真实 tracer 里会变成幽灵。 */
  unclosed(): RecordedSpan[] { return this.spans.filter((s) => !s.ended); }
}

export function fakePlatform(clock = new FakeClock()): Platform & {
  clock: FakeClock; ids: SeqIdGen; logger: CapturingLogger; tracer: RecordingTracer;
} {
  const ids = new SeqIdGen();
  return { clock, ids, logger: new CapturingLogger(), tracer: new RecordingTracer(ids) };
}
