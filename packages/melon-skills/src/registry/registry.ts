import type {
  ModelTool, ResolvedTool, SkillBundle, SkillProvider, Task, ToolId, ToolResolver, ToolsetSnapshot,
} from '@melon-ai/core';
import type { Tool } from './define.js';
import { reviewTool } from './review.js';

/** 工具从哪来。决定同名时谁让谁：内置 > 宿主代码 > 扩展（用户装的技能、MCP）。 */
export type ToolOrigin = 'builtin' | 'host' | 'extension';

export interface RejectedTool {
  readonly id: string;
  readonly origin: ToolOrigin;
  /** 来源名：宿主工具是 'host'，技能来源是它的 provider id。 */
  readonly source: string;
  readonly reasons: readonly string[];
}

export interface RegistrationReport {
  /** 注册成功的工具 id。 */
  readonly accepted: readonly string[];
  /** 被拒绝的，带逐条原因 —— 宿主拿去展示给用户。 */
  readonly rejected: readonly RejectedTool[];
  /** 注册了，但有需要用户知道的问题（比如说明里的不可见字符已被去掉）。 */
  readonly warnings: readonly { readonly id: string; readonly message: string }[];
}

interface Candidate {
  readonly tool: Tool;
  readonly origin: ToolOrigin;
  readonly source: string;
}

const RANK: Record<ToolOrigin, number> = { builtin: 0, host: 1, extension: 2 };

/**
 * 工具注册表：内置技能、宿主定义的工具、扩展技能来源（`SkillProvider`，如用户装的 Agent Skills、MCP）。
 *
 * **任何来源注册前都要过 `reviewTool`**（校验 → 净化 → 审查），不合格的不注册，原因进 `report()`。
 * 同名时按来源定先后：内置 > 宿主 > 扩展 —— 用户装的技能不能顶替内置的发邮件工具。
 *
 * 一处注册，三处可用：
 * - 管线按 id 解析（实现 `ToolResolver`）
 * - 规划器拿到给模型的工具列表（`modelTools(task)`，带全量 schema）
 * - 任务创建时拍工具集快照（`toolset()`）
 *
 * 工具与来源都能在运行中替换（`setTools` / `setProviders`），在跑的任务不受影响：
 * 已经发出去的调用按 id 解析，找不到的由管线当成可修复错误回喂给模型。
 */
export class ToolRegistry implements ToolResolver {
  private hostTools: readonly Tool[] = [];
  private providers: readonly SkillProvider[] = [];
  /** 来源的工具。来源通知变化时刷新 —— 不能每次解析都去 list()，那可能是一次网络往返。 */
  private provided: readonly Candidate[] = [];
  private effective = new Map<string, Tool>();
  private lastReport: RegistrationReport = { accepted: [], rejected: [], warnings: [] };
  private unsubs: (() => void)[] = [];
  private refreshing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(r: RegistrationReport) => void>();

  constructor(opts: { tools?: readonly Tool[]; providers?: readonly SkillProvider[] } = {}) {
    this.setTools(opts.tools ?? []);
    void this.setProviders(opts.providers ?? []);
  }

  setTools(tools: readonly Tool[]): void {
    this.hostTools = tools;
    this.rebuild();
  }

  async setProviders(providers: readonly SkillProvider[]): Promise<void> {
    for (const u of this.unsubs) u();
    this.providers = providers;
    this.unsubs = providers.flatMap((p) => (p.onChange ? [p.onChange(() => { void this.refresh(); })] : []));
    await this.refresh();
  }

  /** 等来源的工具列表就绪。创建引擎时调用一次，之后由来源的变化通知驱动。 */
  ready(): Promise<void> {
    return this.refreshing;
  }

  /** 最近一次注册的结果：哪些通过、哪些被拒及原因。 */
  report(): RegistrationReport {
    return this.lastReport;
  }

  /** 每次重新注册（宿主换工具、来源变化）后回调。 */
  onReport(cb: (r: RegistrationReport) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private refresh(): Promise<void> {
    this.refreshing = (async () => {
      const next: Candidate[] = [];
      for (const p of this.providers) {
        let bundles: readonly SkillBundle[] = [];
        try {
          bundles = await p.list();
        } catch {
          // 一个来源挂了不该拖垮其余的；它的工具这一轮不出现
          continue;
        }
        for (const b of bundles) {
          const origin: ToolOrigin = b.skill.source.kind === 'builtin' ? 'builtin' : 'extension';
          for (const d of b.skill.tools) {
            const handler = b.handlers.get(d.id);
            const when = b.when?.get(d.id);
            if (handler) next.push({ tool: { descriptor: d, handler, ...(when ? { when } : {}) }, origin, source: p.id });
          }
        }
      }
      this.provided = next;
      this.rebuild();
    })();
    return this.refreshing;
  }

  /** 全部候选过一遍审查，按来源先后去重，得出生效的工具集与报告。 */
  private rebuild(): void {
    const candidates: Candidate[] = [
      ...this.provided,
      ...this.hostTools.map((tool) => ({ tool, origin: 'host' as const, source: 'host' })),
    ].sort((a, b) => RANK[a.origin] - RANK[b.origin]);

    const effective = new Map<string, Tool>();
    const holders = new Map<string, Candidate>();
    const rejected: RejectedTool[] = [];
    const warnings: { id: string; message: string }[] = [];

    for (const c of candidates) {
      const id = String(c.tool.descriptor.id);
      const review = reviewTool(c.tool.descriptor);
      const reasons = review.issues.filter((i) => i.level === 'error').map((i) => i.message);
      const holder = holders.get(id);
      if (holder) {
        reasons.push(holder.origin === 'builtin' && c.origin !== 'builtin'
          ? `与内置工具 ${id} 重名 —— 内置工具不能被覆盖`
          : `与已注册的工具重名（来自 ${holder.source}）`);
      }
      if (reasons.length > 0) {
        rejected.push({ id, origin: c.origin, source: c.source, reasons });
        continue;
      }
      for (const w of review.issues) if (w.level === 'warn') warnings.push({ id, message: w.message });
      effective.set(id, { ...c.tool, descriptor: review.descriptor });
      holders.set(id, c);
    }

    this.effective = effective;
    this.lastReport = { accepted: [...effective.keys()], rejected, warnings };
    for (const cb of this.listeners) cb(this.lastReport);
  }

  async resolve(toolId: ToolId): Promise<ResolvedTool | null> {
    const t = this.effective.get(toolId);
    return t ? { descriptor: t.descriptor, handler: t.handler } : null;
  }

  async isEnabledFor(toolId: ToolId): Promise<boolean> {
    return this.effective.has(toolId);
  }

  /**
   * 给模型看的工具，带全量 schema。`when` 不满足的工具不出现 —— 给了模型它就可能去调。
   * `risk` / `triggers` 不发给模型（适配器只取 name / description / input），给规划器的动作守卫用。
   */
  modelTools(task: Task): readonly ModelTool[] {
    return [...this.effective.values()]
      .filter((t) => !t.when || t.when(task))
      .map((t) => ({
        name: t.descriptor.id,
        description: t.descriptor.description,
        // strict tool use 要求 additionalProperties: false
        input: { additionalProperties: false, ...t.descriptor.input, type: 'object' },
        risk: t.descriptor.risk,
        ...(t.descriptor.triggers?.length ? { triggers: t.descriptor.triggers } : {}),
        ...(t.descriptor.userSupplied?.length ? { userSupplied: t.descriptor.userSupplied } : {}),
      }));
  }

  toolset(): ToolsetSnapshot {
    const skills = [...new Set([...this.effective.values()].map((t) => t.descriptor.skillId))];
    return { takenAt: Date.now(), skills: skills.map((id) => ({ id, version: '1' })) };
  }

  /** 列出全部生效工具的描述。宿主做工具开关、展示名时用。 */
  list(): readonly Tool['descriptor'][] {
    return [...this.effective.values()].map((t) => t.descriptor);
  }
}
