/**
 * `@melon-ai/plugins/zhipu` —— 智谱官方价格文档的解析（价格同步用）。
 *
 * 文档有 Markdown 版。文本、视觉模型的表头是「模型名称 | 上下文 | 输入单价（元/百万 Tokens） | 输出单价 | 缓存存储 | 缓存命中」。
 * 有的模型按输入长度分档（「输入长度 [0, 32K)」「≥32K」各一行）：取最低一档。表里是展示名（GLM-5.3），模型 id 是小写（glm-5.3）。
 */
import type { ModelPrice, PriceSheet, PriceSource } from '@melon-ai/core';

export const ZHIPU_PRICING_URL = 'https://docs.bigmodel.cn/cn/guide/start/pricing.md';

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
/** 「8」「0.8」→ 数；「免费」→ 0；「不支持」「-」→ NaN */
const yuan = (s: string): number => (/免费/.test(s) && !/限时/.test(s) ? 0 : Number((/^[\d.]+/.exec(s) ?? ['NaN'])[0]));

export function parseZhipuPricing(md: string): PriceSheet {
  const lines = md.split('\n');
  const prices: Record<string, ModelPrice> = {};
  let tiered = false;
  for (let i = 0; i < lines.length; i++) {
    const head = cells(lines[i]!);
    if (!lines[i]!.trim().startsWith('|') || !head.some((c) => /^输入单价/.test(c)) || !head.some((c) => /^输出单价/.test(c))) continue;
    if (!head.some((c) => /元\/百万\s*Tokens/i.test(c))) continue;
    const ci = head.findIndex((c) => /^输入单价/.test(c));
    const co = head.findIndex((c) => /^输出单价/.test(c));
    const ch = head.findIndex((c) => /^缓存命中/.test(c));
    const cx = head.findIndex((c) => /^上下文/.test(c));
    for (i += 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
      const c = cells(lines[i]!);
      const id = (c[0] ?? '').toLowerCase();
      if (!/^glm-/.test(id) || prices[id]) {
        if (prices[id] && /输入长度/.test(c[cx] ?? '')) tiered = true;
        continue;
      }
      const input = yuan(c[ci] ?? '');
      const output = yuan(c[co] ?? '');
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      const cached = ch >= 0 ? yuan(c[ch] ?? '') : Number.NaN;
      prices[id] = { input, output, ...(Number.isFinite(cached) ? { cachedInput: cached } : {}), currency: 'CNY', source: ZHIPU_PRICING_URL };
    }
  }
  return { prices, ...(tiered ? { notes: ['按输入长度分档的模型取最低一档'] } : {}) };
}

export function zhipuPrices(opts: { fetchImpl?: typeof fetch; url?: string } = {}): PriceSource {
  const url = opts.url ?? ZHIPU_PRICING_URL;
  return {
    vendor: 'zhipu', label: '智谱', url,
    async fetch(signal) {
      const res = await (opts.fetchImpl ?? fetch)(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (melon-ai price sync)' } });
      if (!res.ok) throw new Error(`官方价格文档返回 HTTP ${res.status}`);
      return parseZhipuPricing(await res.text());
    },
  };
}
