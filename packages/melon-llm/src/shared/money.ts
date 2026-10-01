import type { Currency } from '@melon-ai/core';

/** 汇率：1 美元 = 多少该币种。宿主传入，引擎不去拉汇率。 */
export type FxRates = Partial<Record<Currency, number>>;
export const DEFAULT_FX: FxRates = { USD: 1, CNY: 7.2 };

/** 折算成另一个币种。 */
export function convert(amount: number, from: Currency, to: Currency, fx: FxRates = DEFAULT_FX): number {
  if (from === to) return amount;
  const a = fx[from] ?? DEFAULT_FX[from] ?? 1;
  const b = fx[to] ?? DEFAULT_FX[to] ?? 1;
  return (amount / a) * b;
}
