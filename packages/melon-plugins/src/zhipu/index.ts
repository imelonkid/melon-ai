/**
 * `@melon-ai/plugins/zhipu` —— 智谱官方价格文档的解析（价格同步用）。
 *
 * 文档有 Markdown 版。文本、视觉模型的表头是「模型名称 | 上下文 | 输入单价（元/百万 Tokens） | 输出单价 | 缓存存储 | 缓存命中」。
 * 有的模型按输入长度分档（「输入长度 [0, 32K)」「≥32K」各一行）：取最低一档。表里是展示名（GLM-5.3），模型 id 是小写（glm-5.3）。
 */
import type { GeneratedImage, ImageGenerator, ModelPrice, PriceSheet, PriceSource } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';

export const ZHIPU_PRICING_URL = 'https://docs.bigmodel.cn/cn/guide/start/pricing.md';

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
/** 「8」「0.8」→ 数；「免费」→ 0；「不支持」「-」→ NaN */
const yuan = (s: string): number => (/免费/.test(s) && !/限时/.test(s) ? 0 : Number((/^[\d.]+/.exec(s) ?? ['NaN'])[0]));

const MODALITY: Record<string, 'text' | 'image' | 'video' | 'file' | 'audio'> = { 文本: 'text', 图片: 'image', 图像: 'image', 视频: 'video', 文件: 'file', 音频: 'audio', 语音: 'audio' };
const modalities = (s: string) => s.split(/[、,，/\s]+/).map((x) => MODALITY[x.trim()]).filter((x): x is NonNullable<typeof x> => !!x);

export function parseZhipuPricing(md: string): PriceSheet {
  const lines = md.split('\n');
  const prices: Record<string, ModelPrice> = {};
  let tiered = false;
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const h = /^#+\s*(.+)$/.exec(lines[i]!.trim());
    if (h) section = h[1]!;
    const head = cells(lines[i]!);
    if (!lines[i]!.trim().startsWith('|') || !head.some((c) => /^输入单价/.test(c)) || !head.some((c) => /^输出单价/.test(c))) continue;
    if (!head.some((c) => /元\/百万\s*Tokens/i.test(c))) continue;
    const ci = head.findIndex((c) => /^输入单价/.test(c));
    const co = head.findIndex((c) => /^输出单价/.test(c));
    const ch = head.findIndex((c) => /^缓存命中/.test(c));
    const cx = head.findIndex((c) => /^上下文/.test(c));
    const cm = head.findIndex((c) => /^输入模态/.test(c));
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
      // 输入模态：「图片、视频、文件、文本」；没有这一列、但在「视觉理解」一节里的按「文本 + 图片」算
      const inputs = cm >= 0 ? modalities(c[cm] ?? '') : /视觉/.test(section) ? ['text', 'image'] as const : null;
      prices[id] = {
        input, output, ...(Number.isFinite(cached) ? { cachedInput: cached } : {}), currency: 'CNY', source: ZHIPU_PRICING_URL,
        ...(inputs?.length ? { inputs } : {}),
      };
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

// ── 生图 ─────────────────────────────────────────────────────────────

/**
 * 智谱的生图模型（`ImageGenerator`）。价格见官方价格页：GLM-Image 0.1 元/次（旗舰，复杂指令与文字渲染强）；
 * CogView-3-Flash 免费（轻量）。
 *
 * ```ts
 * import { images } from '@melon-ai/agent/images';
 * import { zhipuImages } from '@melon-ai/plugins/zhipu';
 * agent.configure({ skills: [images({ generator: zhipuImages({ apiKey, model: 'cogview-3-flash' }), dir })] });
 * ```
 */
export const ZHIPU_IMAGE_MODELS = [
  { model: 'cogview-3-flash', label: 'CogView-3-Flash', note: '免费 · 轻量图像创作', price: 0 },
  { model: 'glm-image', label: 'GLM-Image', note: '0.1 元/张 · 旗舰，带字的图、海报更好', price: 0.1 },
] as const;

export type ZhipuImageModel = (typeof ZHIPU_IMAGE_MODELS)[number]['model'];

export interface ZhipuImageOptions {
  readonly apiKey: string;
  readonly model?: ZhipuImageModel | string;
  /** 本地联调时指向桩服务。默认官方地址。 */
  readonly baseURL?: string;
  readonly fetchImpl?: typeof fetch;
}

/** 智谱支持的尺寸（长宽都在 512–2048、是 16 的倍数；这里给常用的几个）。第一个是默认。 */
const ZHIPU_SIZES = ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'];

export function zhipuImages(opts: ZhipuImageOptions): ImageGenerator {
  const model = opts.model ?? 'cogview-3-flash';
  const known = ZHIPU_IMAGE_MODELS.find((m) => m.model === model);
  const base = (opts.baseURL ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    vendor: 'zhipu',
    model,
    label: known ? `${known.label}${known.price === 0 ? '（免费）' : ''}` : model,
    ...(known ? { price: { amount: known.price, currency: 'CNY' as const } } : {}),
    sizes: ZHIPU_SIZES,
    async generate(req, signal) {
      const res = await doFetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model, prompt: req.prompt, size: req.size ?? ZHIPU_SIZES[0] }),
        ...(signal ? { signal } : {}),
      });
      const body = await res.json().catch(() => ({})) as { data?: { url?: string; b64_json?: string }[]; error?: { message?: string; code?: string } };
      if (!res.ok) {
        const msg = body.error?.message ?? `HTTP ${res.status}`;
        if (/余额不足|欠费|资源包|充值/.test(msg) || res.status === 402) throw new ToolError('FATAL', `余额不足（${res.status}）：${msg}`, { retriable: false, hint: '去智谱的控制台充值，或换成免费的 CogView-3-Flash' });
        if (res.status === 401 || res.status === 403) throw new ToolError('DENIED', `智谱拒绝了（${res.status}）：${msg}`, { retriable: false, hint: '检查智谱的 API key' });
        if (res.status === 429) throw new ToolError('RATE_LIMITED', `智谱限流：${msg}`);
        if (res.status === 400) throw new ToolError('INVALID_ARGS', `智谱不接受这个请求：${msg}`, { hint: '换个说法再试（可能触发了内容审核）' });
        throw new ToolError('UPSTREAM', `智谱出错（${res.status}）：${msg}`);
      }
      const out: GeneratedImage[] = [];
      for (const d of body.data ?? []) {
        if (d.b64_json) { out.push({ data: Uint8Array.from(atob(d.b64_json), (c) => c.charCodeAt(0)), mime: 'image/png' }); continue; }
        if (!d.url) continue;
        // 智谱给的是临时链接：下载下来，过期了就看不到了
        const img = await doFetch(d.url, { ...(signal ? { signal } : {}) });
        if (!img.ok) throw new ToolError('UPSTREAM', `下载生成的图片失败（HTTP ${img.status}）`);
        out.push({ data: new Uint8Array(await img.arrayBuffer()), mime: img.headers.get('content-type')?.split(';')[0] || 'image/png' });
      }
      if (out.length === 0) throw new ToolError('UPSTREAM', '智谱没有返回图片');
      return out;
    },
  };
}
