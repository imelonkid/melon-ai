/** 把时间、随机、日志这些不纯的东西也做成端口 —— 状态机的可测性依赖于此。 */
export interface Clock {
  now(): number;
}

export interface IdGen {
  next(prefix?: string): string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface Platform {
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
}
