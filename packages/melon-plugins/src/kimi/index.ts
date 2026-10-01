/**
 * `@melon-ai/plugins/kimi` —— Kimi（月之暗面）官方价格文档的解析（价格同步用）。
 *
 * 文档的 Markdown 版里，价格表是组件写法：`<DocTable columns={[{ title: "模型" }, …]} rows={[["kimi-k3", "1M tokens", "¥20.00", …], …]} />`。
 * 按列名找「输入价格（缓存命中）」「输入价格（缓存未命中）」「输出价格」。
 */
import type { ModelPrice, PriceSheet, PriceSource } from '@melon-ai/core';

export const KIMI_PRICING_URL = 'https://platform.kimi.com/docs/pricing/chat.md';

const yuan = (s: string): number => Number((/[\d.]+/.exec(s.replace(/,/g, '')) ?? ['NaN'])[0]);

export function parseKimiPricing(md: string): PriceSheet {
  const prices: Record<string, ModelPrice> = {};
  for (const t of md.matchAll(/<DocTable\s+columns=\{\[([\s\S]*?)\]\}\s+rows=\{\[([\s\S]*?)\]\}\s*\/>/g)) {
    const titles = [...t[1]!.matchAll(/title:\s*"([^"]*)"/g)].map((m) => m[1]!);
    const col = (re: RegExp): number => titles.findIndex((x) => re.test(x));
    const [cm, ch, ci, co] = [col(/^模型$/), col(/缓存命中/), col(/缓存未命中/), col(/^输出价格/)];
    if (cm < 0 || ci < 0 || co < 0) continue;
    for (const r of t[2]!.matchAll(/\[([^[\]]*)\]/g)) {
      const c = [...r[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
      const id = c[cm] ?? '';
      const input = yuan(c[ci] ?? '');
      const output = yuan(c[co] ?? '');
      if (!/^(kimi|moonshot)-/.test(id) || !Number.isFinite(input) || !Number.isFinite(output)) continue;
      const cached = ch >= 0 ? yuan(c[ch] ?? '') : Number.NaN;
      prices[id] = { input, output, ...(Number.isFinite(cached) ? { cachedInput: cached } : {}), currency: 'CNY', source: KIMI_PRICING_URL };
    }
  }
  return { prices, notes: ['写缓存的费用没单独计，按普通输入算'] };
}

export function kimiPrices(opts: { fetchImpl?: typeof fetch; url?: string } = {}): PriceSource {
  const url = opts.url ?? KIMI_PRICING_URL;
  return {
    vendor: 'moonshot', label: 'Kimi', url,
    async fetch(signal) {
      const res = await (opts.fetchImpl ?? fetch)(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (melon-ai price sync)' } });
      if (!res.ok) throw new Error(`官方价格文档返回 HTTP ${res.status}`);
      return parseKimiPricing(await res.text());
    },
  };
}
