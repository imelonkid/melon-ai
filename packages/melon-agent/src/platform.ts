import type {
  Clock, Hasher, IdGen, LogField, LogLevel, Logger, Platform, Span, SpanKind, SpanStatus,
  TraceContext, TraceId, Tracer,
} from '@melon-ai/core';
import { asSpanId, asTraceId } from '@melon-ai/core';

/**
 * 默认平台实现：只用 Web 标准 API（`crypto.randomUUID`、`TextEncoder`、`console`），
 * Node 19+、浏览器、Deno、边缘运行时都能跑 —— 根入口不引用任何 `node:*` 模块（§2.8 宿主无关）。
 * Node 宿主想用原生哈希，改用 `@melon-ai/agent/node` 的 `nodePlatform()`。
 */
export const systemClock: Clock = { now: () => Date.now() };

export const uuidIds: IdGen = { next: (prefix = 'id') => `${prefix}-${globalThis.crypto.randomUUID()}` };

// SHA-256（FIPS 180-4）。端口要求同步，而 WebCrypto 的 digest 是异步的，只好自己算；输入都是短文本（参数、审计记录）
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000));
  view.setUint32(total - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0; h[1] = (h[1]! + b!) >>> 0; h[2] = (h[2]! + c!) >>> 0; h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0; h[5] = (h[5]! + f!) >>> 0; h[6] = (h[6]! + g!) >>> 0; h[7] = (h[7]! + hh!) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

export const webHasher: Hasher = { sha256: sha256Hex };

export interface ConsoleLoggerOptions {
  readonly min?: LogLevel;
  readonly sink?: (line: string) => void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function consoleLogger(opts: ConsoleLoggerOptions = {}): Logger {
  const min = ORDER[opts.min ?? 'info'];
  const sink = opts.sink ?? ((l: string) => { console.error(l); });
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

/** 默认的全套平台实现，任何有 Web 标准 API 的运行时都能用。`createAgent` 不传 `platform` 时用它。 */
export function defaultPlatform(opts: ConsoleLoggerOptions = {}): Platform {
  const logger = consoleLogger(opts);
  return {
    clock: systemClock,
    ids: uuidIds,
    logger,
    hasher: webHasher,
    tracer: loggingTracer(logger, uuidIds),
  };
}
