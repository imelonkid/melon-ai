/**
 * `@melon-ai/plugins/anthropic` —— Claude 官方价格文档的解析（价格同步用）。
 *
 * 文档有 Markdown 版（地址后加 `.md`）。「Model pricing」那张表：模型展示名、基础输入、写缓存（5 分钟 / 1 小时）、缓存命中、输出，单位「$x / MTok」。
 * 表里是展示名（「Claude Opus 5.5」），模型 id 按 Anthropic 的命名规则换（`claude-opus-5-5`）。
 */
import type { ModelPrice, PriceSheet, PriceSource } from '@melon-ai/core';

export const ANTHROPIC_PRICING_URL = 'https://docs.anthropic.com/en/docs/about-claude/pricing.md';

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const usd = (s: string): number => Number((/\$\s*([\d.]+)/.exec(s) ?? ['', 'NaN'])[1]);

/** 「Claude Opus 5.5 ([deprecated](…))」→ `claude-opus-5-5` */
export function anthropicModelId(name: string): string {
  return name.replace(/\(.*?\)\)?/g, '').replace(/<[^>]+>/g, '').trim().toLowerCase().replace(/[.\s]+/g, '-').replace(/-+$/, '');
}

export function parseAnthropicPricing(md: string): PriceSheet {
  const lines = md.split('\n');
  const h = lines.findIndex((l) => /^\|\s*Model\s*\|/.test(l) && /Base input/i.test(l) && /Output/i.test(l));
  if (h < 0) throw new Error('文档里找不到模型价格表');
  const head = cells(lines[h]!);
  const col = (re: RegExp): number => head.findIndex((c) => re.test(c));
  const [ci, ch, co] = [col(/Base input/i), col(/Cache hits/i), col(/Output/i)];
  const prices: Record<string, ModelPrice> = {};
  for (const line of lines.slice(h + 2)) {
    if (!line.trim().startsWith('|')) break;
    const c = cells(line);
    const id = anthropicModelId(c[0] ?? '');
    const input = usd(c[ci] ?? '');
    const output = usd(c[co] ?? '');
    if (!id.startsWith('claude-') || !Number.isFinite(input) || !Number.isFinite(output)) continue;
    const cached = ch >= 0 ? usd(c[ch] ?? '') : Number.NaN;
    prices[id] = { input, output, ...(Number.isFinite(cached) ? { cachedInput: cached } : {}), currency: 'USD', source: ANTHROPIC_PRICING_URL };
  }
  return { prices, notes: ['写缓存的加价没单独计，按普通输入算'] };
}

export function anthropicPrices(opts: { fetchImpl?: typeof fetch; url?: string } = {}): PriceSource {
  const url = opts.url ?? ANTHROPIC_PRICING_URL;
  return {
    vendor: 'anthropic', label: 'Claude', url,
    async fetch(signal) {
      const res = await (opts.fetchImpl ?? fetch)(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (melon-ai price sync)' } });
      if (!res.ok) throw new Error(`官方价格文档返回 HTTP ${res.status}`);
      return parseAnthropicPricing(await res.text());
    },
  };
}
