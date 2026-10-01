/**
 * `@melon-ai/plugins/qwen` —— 通义千问（阿里云百炼）官方价格文档的解析（价格同步用）。
 *
 * 文档是一个很大的 HTML 页，几百张表。要的是表头含「模型 ID」「输入单价（每百万 Token）」「输出单价」的那些。
 * - 同一模型在不同部署范围（中国内地 / 国际 / 美国 / 全球）价格不同：页面先列中国内地，取**第一次出现**的；
 *   带「服务部署范围」列的表只认「中国内地」的行。
 * - 按输入长度分档（`0<Token≤32K`、`32K<Token≤128K` …）：取第一档（最低）。
 * - 上下文缓存只写了「享有折扣」没写价：不填缓存价，按普通输入算。
 */
import type { ModelPrice, PriceSheet, PriceSource } from '@melon-ai/core';

export const QWEN_PRICING_URL = 'https://help.aliyun.com/zh/model-studio/model-pricing';

const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
const yuan = (s: string): number => (/免费/.test(s) ? 0 : Number((/([\d.]+)\s*元/.exec(s) ?? ['', 'NaN'])[1]));

export function parseQwenPricing(html: string): PriceSheet {
  const prices: Record<string, ModelPrice> = {};
  let tiered = false;
  for (const t of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const rows = [...t[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1]!)));
    const head = rows[0] ?? [];
    const col = (re: RegExp): number => head.findIndex((c) => re.test(c));
    const [cm, ci, co, cr, ct] = [col(/^模型\s*ID/), col(/^输入单价/), col(/^输出单价/), col(/部署范围/), col(/输入\s*Token\s*数/)];
    if (cm < 0 || ci < 0 || co < 0 || !head.some((c) => /每百万\s*Token/.test(c))) continue;
    for (const c of rows.slice(1)) {
      // 分档的后几行合并了模型那一格（rowspan），列数少：跳过 —— 第一档已经取过
      if (c.length !== head.length) { tiered = true; continue; }
      if (cr >= 0 && !/中国内地|中国大陆/.test(c[cr] ?? '')) continue;
      const id = (c[cm] ?? '').split(' ')[0]!;
      if (!/^q[a-z0-9]/.test(id) || prices[id]) continue;
      const input = yuan(c[ci] ?? '');
      const output = yuan(c[co] ?? '');
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      if (ct >= 0 && /Token\s*≤/.test(c[ct] ?? '') && !/^0\s*</.test(c[ct] ?? '')) continue;
      if (ct >= 0 && /^0\s*</.test(c[ct] ?? '')) tiered = true;
      prices[id] = { input, output, currency: 'CNY', source: QWEN_PRICING_URL };
    }
  }
  return {
    prices,
    notes: [...(tiered ? ['按输入长度分档的模型取最低一档'] : []), '上下文缓存的折扣没计入，按普通输入算'],
  };
}

export function qwenPrices(opts: { fetchImpl?: typeof fetch; url?: string } = {}): PriceSource {
  const url = opts.url ?? QWEN_PRICING_URL;
  return {
    vendor: 'aliyun', label: '通义千问', url,
    async fetch(signal) {
      const res = await (opts.fetchImpl ?? fetch)(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (melon-ai price sync)' } });
      if (!res.ok) throw new Error(`官方价格文档返回 HTTP ${res.status}`);
      return parseQwenPricing(await res.text());
    },
  };
}
