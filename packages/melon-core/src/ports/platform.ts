import type { ResourceRef } from '../audit.js';
import type { Tracer } from '../trace.js';

/** 把时间、随机、日志这些不纯的东西也做成端口 —— 状态机的可测性依赖于此。 */
export interface Clock {
  now(): number;
}

export interface IdGen {
  next(prefix?: string): string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 日志字段**只接受标量与资源引用**。
 * 类型层面挡住 `logger.info('sent', { email })` 这类把整个对象 dump 进日志的写法 ——
 * 日志不该成为敏感数据的第二份副本（见 docs/architecture.md §2.4）。
 */
export type LogField = string | number | boolean | null | ResourceRef;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Readonly<Record<string, LogField>>): void;
  child(fields: Readonly<Record<string, LogField>>): Logger;
}

export interface Platform {
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly tracer: Tracer;
}
