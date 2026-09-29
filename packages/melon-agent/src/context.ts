import type { ContextBundle, Entry, EpisodeStore, Message, Task } from '@melon-ai/core';
import { BUILTIN_TOOLS } from '@melon-ai/core';

/** 固定窗口：最近这么多条。长任务会撑爆 —— 由 @melon-ai/memory 的预算分配与压缩解决。 */
const MAX_ENTRIES = 40;

const roleOf = (kind: Entry['kind']): Message['role'] => (kind === 'assistant' ? 'assistant' : 'user');

/**
 * thought / tool_call / observation 都以 user 角色回灌 ——
 * 模型看到的是「这是刚刚发生的事实」，而不是它自己说过的话。
 * artifact 句柄必须写进文本，否则模型只看到摘要、不知道有全文可取（§10 第 41 条）。
 */
function render(e: Entry): string {
  if (e.kind === 'observation') {
    const handle = e.artifactRef ? `\n（完整内容句柄：${e.artifactRef}，可用 ${BUILTIN_TOOLS.ARTIFACT_READ} 取全文；摘要已够用就不必读）` : '';
    return `【工具返回】${e.text}${handle}`;
  }
  if (e.kind === 'tool_call') return `【调用工具】${e.text}`;
  return e.text;
}

export interface BasicContextOptions {
  /** 放在任务目标之前的消息，例如宿主的对话历史。 */
  readonly prelude?: (task: Task) => Promise<readonly Message[]> | readonly Message[];
  /** 任务目标的写法。默认「任务目标：…」。 */
  readonly goal?: (task: Task) => string;
  readonly window?: number;
}

/**
 * 默认上下文：任务目标 + 本任务最近的步骤。
 *
 * ⚠️ 这是 `@melon-ai/memory` 就位前的默认实现：**没有预算分配、没有压缩、没有长期记忆检索**。
 * 宿主要在目标之前加点东西（对话历史、当前时间），用 `prelude`，不必整个重写。
 */
export function basicContext(episodes: EpisodeStore, opts: BasicContextOptions = {}) {
  return async (task: Task): Promise<ContextBundle> => {
    const entries = (await episodes.readEntries(task.episodeId)).slice(-MAX_ENTRIES);
    const messages: Message[] = [
      ...(opts.prelude ? await opts.prelude(task) : []),
      { role: 'user', content: opts.goal ? opts.goal(task) : `任务目标：${task.goal}` },
      ...entries.map((e) => ({ role: roleOf(e.kind), content: render(e) })),
    ];
    return {
      messages,
      tools: [],
      slots: [],
      // 粗估：中文约 1 字 1 token、英文约 4 字符 1 token，取中间值
      totalTokens: messages.reduce((n, m) => n + Math.ceil(m.content.length / 2), 0),
      window: opts.window ?? 200_000,
      watermark: 0.7,
    };
  };
}
