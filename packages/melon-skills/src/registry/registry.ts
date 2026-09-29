import type {
  ModelTool, ResolvedTool, SkillProvider, Task, ToolId, ToolResolver, ToolsetSnapshot,
} from '@melon-ai/core';
import type { Tool } from './define.js';

/**
 * 工具注册表：宿主定义的工具 + 技能来源（`SkillProvider`，如联网技能、将来的 MCP）。
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
  private tools = new Map<string, Tool>();
  private providers: readonly SkillProvider[] = [];
  /** 来源的工具缓存。来源通知变化时刷新 —— 不能每次解析都去 list()，那可能是一次网络往返。 */
  private provided = new Map<string, Tool>();
  private unsubs: (() => void)[] = [];
  private refreshing: Promise<void> = Promise.resolve();

  constructor(opts: { tools?: readonly Tool[]; providers?: readonly SkillProvider[] } = {}) {
    this.setTools(opts.tools ?? []);
    void this.setProviders(opts.providers ?? []);
  }

  setTools(tools: readonly Tool[]): void {
    const next = new Map<string, Tool>();
    for (const t of tools) {
      if (next.has(t.descriptor.id)) throw new Error(`工具 id 重复：${t.descriptor.id}`);
      next.set(t.descriptor.id, t);
    }
    this.tools = next;
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

  private refresh(): Promise<void> {
    this.refreshing = (async () => {
      const next = new Map<string, Tool>();
      for (const p of this.providers) {
        for (const b of await p.list()) {
          for (const d of b.skill.tools) {
            const handler = b.handlers.get(d.id);
            if (handler) next.set(d.id, { descriptor: d, handler });
          }
        }
      }
      this.provided = next;
    })();
    return this.refreshing;
  }

  private all(): Tool[] {
    // 宿主自己定义的同名工具优先 —— 宿主要能覆盖内置实现
    return [...new Map([...this.provided, ...this.tools]).values()];
  }

  async resolve(toolId: ToolId): Promise<ResolvedTool | null> {
    const t = this.tools.get(toolId) ?? this.provided.get(toolId);
    return t ? { descriptor: t.descriptor, handler: t.handler } : null;
  }

  async isEnabledFor(toolId: ToolId): Promise<boolean> {
    return this.tools.has(toolId) || this.provided.has(toolId);
  }

  /** 给模型看的工具，带全量 schema。`when` 不满足的工具不出现 —— 给了模型它就可能去调。 */
  modelTools(task: Task): readonly ModelTool[] {
    return this.all()
      .filter((t) => !t.when || t.when(task))
      .map((t) => ({
        name: t.descriptor.id,
        description: t.descriptor.description,
        // strict tool use 要求 additionalProperties: false
        input: { additionalProperties: false, ...t.descriptor.input, type: 'object' },
      }));
  }

  toolset(): ToolsetSnapshot {
    const skills = [...new Set(this.all().map((t) => t.descriptor.skillId))];
    return { takenAt: Date.now(), skills: skills.map((id) => ({ id, version: '1' })) };
  }

  /** 列出全部工具的描述。宿主做工具开关、展示名时用。 */
  list(): readonly Tool['descriptor'][] {
    return this.all().map((t) => t.descriptor);
  }
}
