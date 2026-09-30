import { isIP, isIPv4 } from 'node:net';
import { ToolError } from '@melon-ai/core';

/**
 * 主机名 → 全部 IP。可注入：测试用假解析，非 Node 宿主用自己的实现。
 * 默认走 Node 的 `dns.lookup` —— 本包因此只适用于 Node 宿主（所以走 `/web` 子路径）。
 */
export type Lookup = (host: string) => Promise<readonly string[]>;

export const nodeLookup: Lookup = async (host) => {
  const dns = await import('node:dns/promises');
  return (await dns.lookup(host, { all: true })).map((a) => a.address);
};

/**
 * 地址是否属于本机 / 内网 / 保留段。
 *
 * 不拦的话，网页里一句「读一下 http://192.168.1.1/admin」就能让模型替攻击者
 * 探测用户的内网（SSRF）；169.254.169.254 是云厂商的元数据服务，泄露的是机器凭证。
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)   // 运营商级 NAT
      || (a === 169 && b === 254)             // 链路本地，含云元数据
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1'
    || v6.startsWith('fc') || v6.startsWith('fd')                  // 唯一本地
    || /^fe[89ab]/.test(v6)                                         // 链路本地
    || v6.startsWith('ff');                                         // 组播
}

/**
 * 只放行公网 http(s)。**所有**解析出的地址都得是公网 —— 只查第一个会被多记录绕过。
 *
 * 已知限制：检查与真正连接之间存在 DNS 重绑定窗口。彻底堵需要按解析出的 IP 直连，
 * 等有了自定义 dispatcher 再做。
 */
export async function assertPublicUrl(raw: string, lookup: Lookup): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ToolError('INVALID_ARGS', `不是合法的网址：${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ToolError('INVALID_ARGS', `只能读取 http/https 网址，收到 ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: readonly string[];
  try {
    addrs = isIP(host) ? [host] : await lookup(host);
  } catch {
    throw new ToolError('NOT_FOUND', `域名解析失败：${host}`);
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
    throw new ToolError('DENIED', '不能读取本机或内网地址', { hint: '只能读取公网网页' });
  }
  return u;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (s: string): string => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** HTML → 纯文本。够用即可：去掉 head、脚本样式与标签，保留段落换行。 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = decodeEntities(html
    // head 里只有标题和元信息，标题已经单独取了；留着会让正文以标题开头
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

export interface FetchOptions {
  readonly lookup?: Lookup;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}

export interface Page {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

/**
 * 读网页。手动跟随跳转：**每一跳都重新检查是不是公网**，
 * 否则一个公网页面 302 到 http://127.0.0.1 就绕过了入口检查。
 */
export async function fetchPage(raw: string, signal: AbortSignal, opts: FetchOptions = {}): Promise<Page> {
  const lookup = opts.lookup ?? nodeLookup;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let url = await assertPublicUrl(raw, lookup);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (melon-ai web skill)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = await assertPublicUrl(new URL(loc, url).href, lookup);
      continue;
    }
    if (res.status === 404) throw new ToolError('NOT_FOUND', `网页不存在（404）：${url.href}`);
    if (!res.ok) throw new ToolError('UPSTREAM', `网页返回 HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
      throw new ToolError('FATAL', `不是网页（${type || '未知类型'}），读不了`, { retriable: false });
    }
    // 限制读取大小：一个几百 MB 的「网页」不该拖垮宿主进程
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); break; }
        chunks.push(value);
      }
    }
    const body = new TextDecoder().decode(concat(chunks));
    const parsed = type.includes('html') ? htmlToText(body) : { title: '', text: body.trim() };
    return { url: url.href, ...parsed };
  }
  throw new ToolError('FATAL', '跳转次数过多', { retriable: false });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
