import type { AdminStore } from '@melon-ai/core';
import type { ResourceConfig, ResourceConfigs, ResourceSection, ResourceTestFn, ResourceView, RoutingRuleConfig, RoutingSpec, SharedApi } from './types.js';

/** 回传它表示「这个密钥不改」（后台页面拿不到明文）。 */
export const KEEP = '__KEEP__';

const KEY_CONFIGS = 'resources';
const KEY_ROUTING = 'routing.rules';
const KEY_VERSION = 'resources.version';

const mask = (v: string): string => (!v ? '' : v.length <= 12 ? '••••••••' : `${v.slice(0, 4)}••••••••${v.slice(-4)}`);

/**
 * 共享资源与路由规则：宿主统一提供给所有用户的模型、搜索…… 的配置，存在后台存储里。
 * 后台只按宿主的描述存、画表单、打码；怎么用是宿主的事（`configs()` 拿明文，`watch` 等变化）。
 * 有版本号：命令行或别的进程改了，`watch` 轮询也能发现。
 */
export class SharedResources implements SharedApi {
  private listeners = new Set<() => void>();
  private seen = -1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: AdminStore,
    readonly sections: readonly ResourceSection[],
    private readonly test?: ResourceTestFn,
    readonly routing?: RoutingSpec,
  ) {}

  private section(kind: string): ResourceSection {
    const s = this.sections.find((x) => x.kind === kind);
    if (!s) throw new Error(`没有这类资源：${kind}`);
    return s;
  }

  /** 全部配置（含明文密钥）。给宿主用，不要发给页面。只留宿主描述过的厂商和字段。 */
  async configs(): Promise<ResourceConfigs> {
    const raw = ((await this.store.getSetting(KEY_CONFIGS)) ?? {}) as Record<string, Record<string, ResourceConfig>>;
    const out: Record<string, Record<string, ResourceConfig>> = {};
    for (const s of this.sections) {
      out[s.kind] = {};
      for (const v of s.vendors) {
        const c = raw[s.kind]?.[v.id];
        if (!c) continue;
        out[s.kind]![v.id] = { enabled: !!c.enabled, values: Object.fromEntries(v.fields.map((f) => [f.key, String(c.values?.[f.key] ?? '')])) };
      }
    }
    return out;
  }

  /** 给页面看的：密钥打码。 */
  async view(): Promise<Record<string, Record<string, ResourceView>>> {
    const cfg = await this.configs();
    const out: Record<string, Record<string, ResourceView>> = {};
    for (const s of this.sections) {
      out[s.kind] = {};
      for (const v of s.vendors) {
        const c = cfg[s.kind]?.[v.id];
        const values: Record<string, string> = {};
        const filled: Record<string, boolean> = {};
        for (const f of v.fields) {
          const val = c?.values[f.key] ?? '';
          values[f.key] = f.secret ? mask(val) : val;
          filled[f.key] = !!val;
        }
        out[s.kind]![v.id] = { enabled: !!c?.enabled, values, filled };
      }
    }
    return out;
  }

  /** 把页面回传的值和存着的合起来：密钥回传 `__KEEP__` 就用原来的。 */
  private async merged(kind: string, vendorId: string, values: Readonly<Record<string, unknown>>): Promise<Record<string, string>> {
    const v = this.section(kind).vendors.find((x) => x.id === vendorId);
    if (!v) throw new Error(`没有这一家：${vendorId}`);
    const cur = (await this.configs())[kind]?.[vendorId]?.values ?? {};
    return Object.fromEntries(v.fields.map((f) => {
      const next = values[f.key];
      const keep = next === undefined || next === KEEP || (f.secret && next === mask(cur[f.key] ?? ''));
      return [f.key, keep ? (cur[f.key] ?? '') : String(next).trim()];
    }));
  }

  /** 改一家：启用开关、字段。启用时必填的字段不能空；只能启用一家的那类，启用这家就停用别家。 */
  async set(kind: string, vendorId: string, patch: { readonly enabled?: boolean; readonly values?: Readonly<Record<string, unknown>> }): Promise<void> {
    const s = this.section(kind);
    const v = s.vendors.find((x) => x.id === vendorId);
    if (!v) throw new Error(`没有这一家：${vendorId}`);
    const all = ((await this.store.getSetting(KEY_CONFIGS)) ?? {}) as Record<string, Record<string, ResourceConfig>>;
    const values = await this.merged(kind, vendorId, patch.values ?? {});
    const enabled = patch.enabled ?? !!all[kind]?.[vendorId]?.enabled;
    if (enabled) {
      const missing = v.fields.filter((f) => !f.optional && !values[f.key]).map((f) => f.label);
      if (missing.length) throw new Error(`启用前要填：${missing.join('、')}`);
    }
    const next = { ...all, [kind]: { ...(all[kind] ?? {}), [vendorId]: { enabled, values } } };
    if (enabled && s.multiple === false) {
      for (const other of Object.keys(next[kind]!)) if (other !== vendorId) next[kind]![other] = { ...next[kind]![other]!, enabled: false };
    }
    await this.store.setSetting(KEY_CONFIGS, next);
    await this.bump();
  }

  /** 测试连通性（宿主实现）。页面没改的密钥用存着的。 */
  async runTest(kind: string, vendorId: string, values: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; message: string }> {
    if (!this.test) return { ok: false, message: '这个服务没有提供测试' };
    try { return await this.test(kind, vendorId, await this.merged(kind, vendorId, values)); }
    catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
  }

  /** 路由规则：`任务类别 → { minTier?, pin? }`，只留宿主描述过的类别。 */
  async routingRules(): Promise<Record<string, RoutingRuleConfig>> {
    const raw = ((await this.store.getSetting(KEY_ROUTING)) ?? {}) as Record<string, RoutingRuleConfig>;
    const out: Record<string, RoutingRuleConfig> = {};
    for (const c of this.routing?.classes ?? []) {
      const r = raw[c.id];
      if (r && (r.minTier || r.pin)) out[c.id] = { ...(r.minTier ? { minTier: r.minTier } : {}), ...(r.pin ? { pin: r.pin } : {}) };
    }
    return out;
  }

  async setRoutingRules(rules: Readonly<Record<string, RoutingRuleConfig>>): Promise<Record<string, RoutingRuleConfig>> {
    const tiers = new Set((this.routing?.tiers ?? DEFAULT_TIERS).map((t) => t.id));
    const out: Record<string, RoutingRuleConfig> = {};
    for (const c of this.routing?.classes ?? []) {
      const r = rules[c.id];
      if (!r) continue;
      const minTier = r.minTier && tiers.has(r.minTier) ? r.minTier : undefined;
      const pin = typeof r.pin === 'string' && r.pin.trim() ? r.pin.trim() : undefined;
      if (minTier || pin) out[c.id] = { ...(minTier ? { minTier } : {}), ...(pin ? { pin } : {}) };
    }
    await this.store.setSetting(KEY_ROUTING, out);
    await this.bump();
    return out;
  }

  private async bump(): Promise<void> {
    const v = Number((await this.store.getSetting(KEY_VERSION)) ?? 0) + 1;
    await this.store.setSetting(KEY_VERSION, v);
    this.seen = v;
    for (const cb of this.listeners) { try { cb(); } catch { /* 一个出错不影响别的 */ } }
  }

  /**
   * 共享资源或路由规则变了就回调（这个进程里改的立即回调；别的进程改的轮询发现）。返回取消函数。
   */
  watch(cb: () => void, pollMs = 3000): () => void {
    this.listeners.add(cb);
    if (!this.timer) {
      void this.store.getSetting(KEY_VERSION).then((v) => { if (this.seen < 0) this.seen = Number(v ?? 0); });
      this.timer = setInterval(() => {
        void this.store.getSetting(KEY_VERSION).then((v) => {
          const n = Number(v ?? 0);
          if (this.seen >= 0 && n !== this.seen) {
            this.seen = n;
            for (const l of this.listeners) { try { l(); } catch { /* 同上 */ } }
          }
        }).catch(() => {});
      }, pollMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    };
  }
}

export const DEFAULT_TIERS: readonly { id: string; label: string }[] = [
  { id: 'basic', label: '基础' }, { id: 'standard', label: '标准' }, { id: 'strong', label: '强' },
];
