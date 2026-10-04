import type { AdminStore, QuotaPolicy, SpendEntry, SpendQuery } from '@melon-ai/core';

/** 后台存储的内存版：测试、试用。进程退出即丢失。 */
export class InMemoryAdminStore implements AdminStore {
  private readonly settings = new Map<string, unknown>();
  private readonly policies = new Map<string, QuotaPolicy>();
  private spend: SpendEntry[] = [];

  async getSetting(key: string): Promise<unknown> { return this.settings.get(key); }
  async setSetting(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.settings.delete(key); else this.settings.set(key, structuredClone(value));
  }
  async getPolicy(principal: string): Promise<QuotaPolicy | null> { return this.policies.get(principal) ?? null; }
  async setPolicy(principal: string, policy: QuotaPolicy | null): Promise<void> {
    if (!policy || policy.mode === 'default') this.policies.delete(principal); else this.policies.set(principal, policy);
  }
  async listPolicies(): Promise<Readonly<Record<string, QuotaPolicy>>> { return Object.fromEntries(this.policies); }
  async recordSpend(e: SpendEntry): Promise<void> { this.spend.push(e); }
  async sumCounted(principal: string, from: number, to = Number.MAX_SAFE_INTEGER): Promise<number> {
    return this.spend.filter((e) => e.principal === principal && e.counted && e.at >= from && e.at < to).reduce((s, e) => s + e.amount, 0);
  }
  async listSpend(q: SpendQuery): Promise<readonly SpendEntry[]> {
    const to = q.to ?? Number.MAX_SAFE_INTEGER;
    return this.spend.filter((e) => e.at >= q.from && e.at < to && (q.principal === undefined || e.principal === q.principal) && (!q.countedOnly || e.counted))
      .sort((a, b) => a.at - b.at);
  }
  async purgeSpend(before: number): Promise<void> { this.spend = this.spend.filter((e) => e.at >= before); }
}
