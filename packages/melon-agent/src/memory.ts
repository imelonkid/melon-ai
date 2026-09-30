import type { ContextBundle, Memory, MemoryStore, Message, Task } from '@melon-ai/core';
import { activeMemories } from '@melon-ai/skills';

/** 记忆不多时全部带上；多了按这一轮的目标检索一部分 + 最重要的一部分。 */
const ALL_UP_TO = 30;
const PICK = 15;

/**
 * 这一轮要带给模型的记忆。
 *
 * **注入而不是等模型来查**（§2.7 的「预召回种子」让步）：第一轮模型对用户一无所知，
 * 它得先「猜到」值得去查，否则 Agent 会显得失忆 —— 用户说「发到我的邮箱」，它想不起记过的地址。
 * 个人用户的记忆通常就几十条，全带上比猜更可靠；多了再靠检索。
 */
export async function memoriesFor(store: MemoryStore, task: Task): Promise<readonly Memory[]> {
  const all = await activeMemories(store, 500);
  if (all.length <= ALL_UP_TO) return all;
  const hits = (await store.search({ scope: 'user', text: task.goal, limit: PICK })).map((s) => s.item);
  const picked = new Map(hits.map((m) => [m.id, m]));
  for (const m of all) {
    if (picked.size >= ALL_UP_TO) break;
    picked.set(m.id, m);
  }
  return [...picked.values()];
}

export function memoryMessage(memories: readonly Memory[]): Message | null {
  if (memories.length === 0) return null;
  return {
    role: 'user',
    // 不是这一轮用户说的，但来自用户之前的原话：参数来源核对时算数（见 Message.from）
    from: 'memory',
    content: [
      '（你记得的关于用户的事，来自之前的对话。用得上就用；和用户这次说的冲突时，以这次为准。）',
      ...memories.map((m) => `- ${m.statement}`),
    ].join('\n'),
  };
}

/**
 * 给任意上下文装配加上记忆。放在最前面：记忆很少变，前缀稳定才吃得到 prompt cache
 * （对话历史、当前时间这些每轮都变的在后面）。
 */
export function withMemory(
  build: (task: Task) => Promise<ContextBundle>,
  store: MemoryStore,
  enabled: () => boolean,
): (task: Task) => Promise<ContextBundle> {
  return async (task) => {
    const ctx = await build(task);
    if (!enabled()) return ctx;
    const msg = memoryMessage(await memoriesFor(store, task));
    if (!msg) return ctx;
    return { ...ctx, messages: [msg, ...ctx.messages], totalTokens: ctx.totalTokens + Math.ceil(msg.content.length / 2) };
  };
}
