/**
 * `@melon-ai/plugins/deepseek` —— DeepSeek 官方价格文档的解析（价格同步用）。
 *
 * 文档是一张 HTML 表：首行是模型名，价格三行（缓存命中 / 缓存未命中 / 输出）各分空闲、高峰两档；
 * 高峰时段写在表下的注释里（「北京时间周一至周五 9:00 - 12:00、14:00 - 18:00 为高峰时段」），旧模型名写在注释 (1) 里。
 */
import type { ModelPrice, PeakPricing, PriceSheet, PriceSource } from '@melon-ai/core';

export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const num = (s: string): number => Number((/[\d.]+/.exec(s) ?? ['NaN'])[0]);

export function parseDeepseekPricing(html: string): PriceSheet {
  const table = /<table[\s\S]*?<\/table>/.exec(html)?.[0];
  if (!table) throw new Error('页面里没有价格表');
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1]!)));
  const head = rows.find((r) => r[0] === '模型');
  if (!head) throw new Error('价格表里找不到「模型」一行');
  // 模型名后面可能带注释编号「(1)」
  const models = head.slice(1).map((c) => c.replace(/\(\d+\)|（\d+）/g, '').trim()).filter((c) => /^deepseek-/.test(c));
  const n = models.length;
  if (n === 0) throw new Error('价格表里没有模型名');
  // 价格行：带「空闲时段」/「高峰时段」，最后 n 格是各模型的价；前一格之前的某格写着是哪一项
  let item = '';
  const vals: Record<string, { idle?: number[]; peak?: number[] }> = {};
  for (const r of rows) {
    const slot = r.find((c) => c === '空闲时段' || c === '高峰时段');
    if (!slot) continue;
    const label = r.find((c) => /输入|输出/.test(c));
    if (label) item = /缓存命中/.test(label) && !/未命中/.test(label) ? 'cached' : /未命中/.test(label) ? 'input' : 'output';
    if (!item) continue;
    (vals[item] ??= {})[slot === '空闲时段' ? 'idle' : 'peak'] = r.slice(-n).map(num);
  }
  if (!vals.input?.idle || !vals.output?.idle) throw new Error('价格表里读不到输入或输出价');

  const plain = text(html);
  const peak = peakOf(plain, vals.input.idle[0]!, vals.input.peak?.[0]);
  const prices: Record<string, ModelPrice> = {};
  models.forEach((m, i) => {
    prices[m] = {
      input: vals.input!.idle![i]!, output: vals.output!.idle![i]!,
      ...(vals.cached?.idle ? { cachedInput: vals.cached.idle[i]! } : {}),
      currency: 'CNY', source: DEEPSEEK_PRICING_URL, ...(peak ? { peak } : {}),
    };
  });
  // 注释里的旧模型名：「模型名请使用 X 。旧模型名 A 、 B 仍可调用 …… 按 Flash 价格计费」
  const alias = /模型名请使用\s*(deepseek-[\w.-]+)\s*。\s*旧模型名(.*?)仍可调用/.exec(plain);
  if (alias && prices[alias[1]!]) {
    for (const old of alias[2]!.match(/deepseek-[\w.-]+/g) ?? []) prices[old] ??= prices[alias[1]!]!;
  }
  return { prices, ...(peak ? {} : { notes: ['没读到高峰时段的说明，按全天同价计'] }) };
}

/** 「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段」 */
function peakOf(plain: string, idle: number, peak?: number): PeakPricing | undefined {
  const s = /北京时间(周[一二三四五六日]至周[一二三四五六日])[^。；]*?((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}[、，, ]*)+)\s*为高峰时段/.exec(plain);
  if (!s || !peak || !idle) return undefined;
  const D: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7 };
  const [a, b] = [...s[1]!.matchAll(/周([一二三四五六日])/g)].map((m) => D[m[1]!]!);
  const days = Array.from({ length: b! - a! + 1 }, (_, k) => a! + k);
  const pad = (t: string): string => t.padStart(5, '0');
  const windows = [...s[2]!.matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)].map((m) => ({ days, from: pad(m[1]!), to: pad(m[2]!) }));
  return windows.length ? { multiplier: Math.round((peak / idle) * 100) / 100, timeZone: 'Asia/Shanghai', windows } : undefined;
}

export function deepseekPrices(opts: { fetchImpl?: typeof fetch; url?: string } = {}): PriceSource {
  const url = opts.url ?? DEEPSEEK_PRICING_URL;
  return {
    vendor: 'deepseek', label: 'DeepSeek', url,
    async fetch(signal) {
      const res = await (opts.fetchImpl ?? fetch)(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (melon-ai price sync)' } });
      if (!res.ok) throw new Error(`官方价格文档返回 HTTP ${res.status}`);
      return parseDeepseekPricing(await res.text());
    },
  };
}
