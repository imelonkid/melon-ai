import type {
  AgentProfile, ModelTool, ResolvedTool, SkillBundle, SkillProvider, Task, ToolId, ToolResolver, ToolsetSnapshot,
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
  /** 由哪个技能提供（技能来源的 bundle id）。宿主直接给的工具没有，按工具 id 的前缀算。 */
  readonly skill?: string;
}

/**
 * 工具定义的指纹：模型和准入看得到的部分（说明、参数、风险、授权与触发声明）。
 * FNV-1a 两路拼成 16 位十六进制 —— 只用来比对是否变了，不防碰撞攻击（来源若能控制碰撞，它也能直接控制说明）。
 */
export function fingerprint(d: Tool['descriptor']): string {
  const text = JSON.stringify([d.description, d.input, d.risk, d.scopeKeys ?? null, d.untrustedOutput ?? false, d.userSupplied ?? null, d.grantBy?.key ?? null]);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** 引擎自己的基础工具（读完整内容、技能查找、记忆、历史）：定制 Agent 限技能时也总在。 */
// 定制 Agent 的技能白名单之外总会给的：读完整内容（`builtin`）、画布（只在绑定了画布的任务里出现，`when`）
const ALWAYS_SKILLS = new Set(['builtin', 'canvas']);

const RANK: Record<ToolOrigin, number> = { builtin: 0, host: 1, extension: 2 };

/**
 * 内置技能占用的工具 id 前缀。扩展（用户装的技能、MCP）不能用 ——
 * 否则宿主没开联网时，一个自称 `web.fetch` 的扩展工具就能顶上来，而它没有内网拦截。
 */
const RESERVED_PREFIXES = ['builtin.', 'artifact.', 'schedule.', 'web.', 'mail.'];

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
  /** 定制 Agent：各自能用哪些技能。 */
  private profiles = new Map<string, AgentProfile>();
  /** 每个生效的工具由哪个技能提供（白名单按它算：同是 builtin. 开头，记忆和读完整内容是两个技能）。 */
  private skillOf = new Map<string, string>();

  private readonly now: () => number;

  constructor(opts: { tools?: readonly Tool[]; providers?: readonly SkillProvider[]; now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
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
            if (handler) next.push({ tool: { descriptor: d, handler, ...(when ? { when } : {}) }, origin, source: p.id, skill: String(b.skill.id) });
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
    const skillOf = new Map<string, string>();
    const holders = new Map<string, Candidate>();
    const rejected: RejectedTool[] = [];
    const warnings: { id: string; message: string }[] = [];

    for (const c of candidates) {
      const id = String(c.tool.descriptor.id);
      const review = reviewTool(c.tool.descriptor);
      const reasons = review.issues.filter((i) => i.level === 'error').map((i) => i.message);
      const holder = holders.get(id);
      if (c.origin === 'extension' && RESERVED_PREFIXES.some((x) => id.startsWith(x))) {
        reasons.push(`${id.slice(0, id.indexOf('.'))}. 开头的名字留给引擎内置技能，扩展不能使用`);
      }
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
      skillOf.set(id, c.skill ?? String(review.descriptor.skillId));
      holders.set(id, c);
    }

    this.effective = effective;
    this.skillOf = skillOf;
    this.lastReport = { accepted: [...effective.keys()], rejected, warnings };
    for (const cb of this.listeners) cb(this.lastReport);
  }

  async resolve(toolId: ToolId, snapshot?: ToolsetSnapshot): Promise<ResolvedTool | null> {
    const t = this.effective.get(toolId);
    if (!t) return null;
    // 任务开始时记下的定义和现在的对不上：含义变了，本任务不认（快照之后才出现的照常）
    const was = snapshot?.tools?.[toolId];
    if (was !== undefined && was !== fingerprint(t.descriptor)) return null;
    return { descriptor: t.descriptor, handler: t.handler };
  }

  /** 换定制 Agent 的定义（能用哪些技能）。 */
  setAgents(profiles: readonly AgentProfile[]): void {
    this.profiles = new Map(profiles.map((p) => [p.id, p]));
  }

  /** 这个 Agent 能不能用这个工具：没定义的、没限技能的都能；引擎的基础工具总能。 */
  private allowed(d: Tool['descriptor'], agentId: string | undefined): boolean {
    const p = agentId === undefined ? undefined : this.profiles.get(agentId);
    if (!p?.skills) return true;
    const skill = this.skillOf.get(String(d.id)) ?? String(d.skillId);
    return ALWAYS_SKILLS.has(skill) || p.skills.includes(skill);
  }

  async isEnabledFor(toolId: ToolId, agentId?: string): Promise<boolean> {
    const t = this.effective.get(toolId);
    return !!t && this.allowed(t.descriptor, agentId);
  }

  /**
   * 给模型看的工具，带全量 schema。`when` 不满足的工具不出现 —— 给了模型它就可能去调。
   * `risk` / `triggers` 不发给模型（适配器只取 name / description / input），给规划器的动作守卫用。
   */
  modelTools(task: Task): readonly ModelTool[] {
    return [...this.effective.values()]
      .filter((t) => (!t.when || t.when(task)) && this.allowed(t.descriptor, String(task.agentId)))
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
    const tools: Record<string, string> = {};
    for (const [id, t] of this.effective) tools[id] = fingerprint(t.descriptor);
    return { takenAt: this.now(), skills: skills.map((id) => ({ id, version: '1' })), tools };
  }

  /** 列出全部生效工具的描述。宿主做工具开关、展示名时用。 */
  list(): readonly Tool['descriptor'][] {
    return [...this.effective.values()].map((t) => t.descriptor);
  }
}
