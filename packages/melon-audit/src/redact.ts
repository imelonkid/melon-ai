import { MAX_DIMENSION_LENGTH } from '@melon-ai/core';
import type { AuditDraft } from '@melon-ai/core';

export class DimensionTooLongError extends Error {
  constructor(readonly key: string, readonly length: number) {
    super(
      `审计维度 "${key}" 长度 ${length} 超过上限 ${MAX_DIMENSION_LENGTH}。` +
      `维度只放计数、类型、枚举；内容请写进负载并用 resource.ref 引用。`,
    );
    this.name = 'DimensionTooLongError';
  }
}

/**
 * 脱敏检查。
 *
 * 类型系统已挡住「把对象塞进审计」，但挡不住「把邮件正文塞进一个字符串维度」。
 * 长字符串正是内容泄漏的特征。
 *
 * **超限抛错，不静默截断** —— 截断会让作者以为自己记下了内容，
 * 而实际上既没记全又违反了 §2.4。
 */
export function assertRedacted(draft: AuditDraft): void {
  if (!draft.dimensions) return;
  for (const [k, v] of Object.entries(draft.dimensions)) {
    if (typeof v === 'string' && v.length > MAX_DIMENSION_LENGTH) {
      throw new DimensionTooLongError(k, v.length);
    }
  }
}
