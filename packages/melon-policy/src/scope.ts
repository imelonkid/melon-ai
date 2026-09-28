import type { ToolDescriptor } from '@melon-ai/core';

/** 无范围概念的工具用这个 scope。 */
export const SCOPE_ANY = '*';

const scalar = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(scalar).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${k}:${scalar(o[k])}`).join(',')}}`;
  }
  return String(v);
};

/**
 * 计算授权范围字符串。
 *
 * 结果是**人可读的**，因为用户要在设置页复核「我都始终允许过什么」，
 * 审计记录里也要能直接看懂。所以不哈希。
 *
 * 例：`mail.send` 声明 `scopeKeys: ['to']`，参数 `{to:'产品组', subject:'周报'}`
 *     → `to=产品组`（不含 subject，所以授权覆盖同一收件人的任意主题）
 */
export function computeScope(descriptor: ToolDescriptor, args: unknown): string {
  const keys = descriptor.scopeKeys;
  if (!keys || keys.length === 0) return SCOPE_ANY;
  if (args === null || typeof args !== 'object') return SCOPE_ANY;
  const o = args as Record<string, unknown>;
  // 键按声明顺序，不排序 —— 声明顺序是作者的语义意图
  return keys.map((k) => `${k}=${scalar(o[k])}`).join('&');
}

/** 范围是否匹配。`*` 只匹配 `*` —— 不做通配展开，避免意外放宽。 */
export function scopeMatches(granted: string, requested: string): boolean {
  return granted === requested;
}
