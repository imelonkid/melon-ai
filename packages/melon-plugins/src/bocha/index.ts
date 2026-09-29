import type { SearchProvider } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';

/**
 * `@melon-ai/plugins/bocha` —— 博查网页搜索，实现 core 的 `SearchProvider`。
 *
 * ```ts
 * import { web } from '@melon-ai/agent/web';
 * import { bocha } from '@melon-ai/plugins/bocha';
 * agent.configure({ skills: [web({ search: bocha({ apiKey }) })] });
 * ```
 */
export interface BochaOptions {
  readonly apiKey: string;
  /** 本地联调时指向桩服务。默认官方地址。 */
  readonly baseURL?: string;
}

const BOCHA_URL = 'https://api.bochaai.com/v1/web-search';

interface BochaPage {
  readonly name?: string;
  readonly url?: string;
  readonly summary?: string;
  readonly snippet?: string;
  readonly siteName?: string;
  readonly datePublished?: string;
}

/**
 * 接口与字段以官方 bocha-search-mcp 的实现为准：
 * `POST {query, summary, freshness, count}` → `data.webPages.value[]`。
 * 协议的时间范围取值与博查一致，不用映射。
 *
 * 错误按协议约定给码：key 无效是 DENIED（重试没用），限流 RATE_LIMITED，其余 UPSTREAM。
 */
export function bocha(opts: BochaOptions): SearchProvider {
  return {
    id: 'bocha',
    label: '博查',
    async search(q, signal) {
      const res = await fetch(opts.baseURL || BOCHA_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q.query, summary: true, freshness: q.freshness, count: q.count }),
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new ToolError('DENIED', '博查拒绝了请求：API key 无效或已过期', { hint: '检查搜索服务的 API key' });
      }
      if (res.status === 429) throw new ToolError('RATE_LIMITED', '博查限流');
      if (!res.ok) throw new ToolError('UPSTREAM', `博查返回 HTTP ${res.status}`);
      const body = await res.json() as { code?: number; msg?: string; message?: string; data?: { webPages?: { value?: BochaPage[] } } };
      // 余额不足之类的业务错误走 200 + code
      if (body.code !== undefined && body.code !== 200) {
        throw new ToolError('UPSTREAM', `博查返回错误：${body.msg ?? body.message ?? body.code}`);
      }
      return (body.data?.webPages?.value ?? []).map((r) => ({
        title: r.name ?? '',
        url: r.url ?? '',
        summary: String(r.summary || r.snippet || ''),
        site: r.siteName ?? '',
        date: r.datePublished ? String(r.datePublished).slice(0, 10) : '',
      }));
    },
  };
}
