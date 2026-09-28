import type { Hasher } from '@melon-ai/core';

/** 规范化 JSON：键排序、undefined 与 null 区分，保证同义参数得到同一个串。 */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'u';
  if (v === null) return 'n';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * 全量参数哈希。
 *
 * **只用于循环检测与幂等，不用于授权** —— 授权用 `melon-policy` 的可读 `scope`。
 * 两者混用会导致「改了个无关参数就得重新授权」或「授权范围被意外放宽」。
 */
export const argsHash = (h: Hasher, args: unknown): string =>
  h.sha256(canonicalJson(args)).slice(0, 32);

/** 非幂等工具的重放保护键。同一次调用（含 callId）重放时命中同一个键。 */
export const idempotencyKey = (h: Hasher, toolId: string, callId: string, args: unknown): string =>
  h.sha256(`${toolId}|${callId}|${canonicalJson(args)}`).slice(0, 32);
