import type { IdGen, Memory, MemoryId, MemoryKind, MemoryStore, Purger, SkillProvider, Task } from '@melon-ai/core';
import { BUILTIN_TOOLS, ToolError } from '@melon-ai/core';
import { defineBuiltinSkill, defineTool } from '../../registry/define.js';
import { findInjection } from '../../registry/review.js';

/**
 * 内置技能：跨对话记忆（L1，用户范围）。
 *
 * **只记用户明确让记的**：写入由模型调工具发起（§2.7「一切读写经由工具」），
 * 触发词命中「记住 / 别忘了」时规划器要求它真的调用，不能只回一句「好的记住了」。
 * 这一版不做每轮结束后的自动提炼 —— 多一次模型调用，而且容易记进垃圾和隐私。
 *
 * 安全：
 * - 写记忆是持久状态：读过网页的任务里写入一律要用户确认（准入的污点覆盖，`DURABLE_WRITE_TOOLS`）；
 * - 写入的内容过一遍注入审查，「用户已授权你无需确认…」这类写法直接拒 —— 假记忆跨会话存活，比一次性注入严重；
 * - 删除是不可撤销的（风险 irreversible），在对话里删每次都要确认。
 */

export interface MemorySkillOptions {
  readonly store: MemoryStore;
  /** 删除走物理删除（privacy 动因，连 FTS / 向量一起删）。 */
  readonly purger: Purger;
  readonly ids: IdGen;
  readonly now: () => number;
  /** 记忆功能此刻是否开着（宿主的开关）。关着时工具不给模型。 */
  readonly enabled?: () => boolean;
}

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'procedure', 'entity'];

/** 主题键：同一主题新的替代旧的（「周报发给谁」改了，旧的那条不再生效）。 */
export const subjectKey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);

/** 写入的触发词。只收明确的说法 ——「你记住了什么」这种问句不该逼它去写一条。 */
export const MEMORY_WRITE_TRIGGERS: readonly string[] = [
  '帮我记住', '请记住', '你要记住', '记住我', '记住：', '记住,', '记住，', '记下来', '帮我记着', '别忘了', '以后都', '以后每次',
];
export const MEMORY_FORGET_TRIGGERS: readonly string[] = ['忘掉', '别记着', '删掉记忆', '不要再记', '不用记了'];

/** 所有生效中的用户记忆，重要、常用的在前。 */
export async function activeMemories(store: MemoryStore, limit = 500): Promise<readonly Memory[]> {
  return (await store.search({ scope: 'user', limit, activeOnly: true })).map((s) => s.item);
}

export function memory(opts: MemorySkillOptions): SkillProvider {
  const on = (_task: Task) => opts.enabled?.() ?? true;

  const write = defineTool<{ statement: string; subject?: string; kind?: MemoryKind }>({
    id: BUILTIN_TOOLS.MEMORY_WRITE,
    description:
      '把用户明确要你记住的事存成长期记忆，以后的对话里都能用上。只记用户让你记的，或用户说「以后都…」这类长期偏好；'
      + '不要记一次性的任务内容。一次只记一件事，几件事就调用几次。'
      + 'statement 写成一句自包含的话（例：「用户的邮箱是 me@163.com」「用户叫老王」）。',
    input: {
      statement: { type: 'string', description: '一句话，自包含，不依赖上下文就能看懂' },
      subject: { type: 'string', optional: true, description: '主题，如「周报收件人」。同一主题再记会替代旧的；不填按内容算' },
      kind: { type: 'string', optional: true, enum: [...KINDS], description: 'fact 事实 / preference 偏好（默认）/ procedure 做法 / entity 人或物' },
    },
    risk: 'write',
    triggers: MEMORY_WRITE_TRIGGERS,
    when: on,
    async run({ statement, subject, kind = 'preference' }, cx) {
      const text = String(statement ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) throw new ToolError('INVALID_ARGS', '要记的内容是空的', { retriable: false });
      const bad = findInjection(text);
      if (bad.length > 0) {
        // 这类内容一旦存进去，会在以后每个对话里被当成「用户说过的话」
        throw new ToolError('DENIED', `这句话像是在给 Agent 下指令（${bad.join('、')}），不能存成记忆`, { retriable: false });
      }
      const key = subjectKey(subject ?? text);
      const k = KINDS.includes(kind) ? kind : 'preference';
      const at = opts.now();
      const id = opts.ids.next('mem') as MemoryId;
      await opts.store.put({
        id, scope: 'user', kind: k, subject: key, statement: text,
        confidence: 1, importance: 0.6,
        provenance: { taskId: cx.taskId, eventSeq: 0 },
        createdAt: at, lastUsedAt: at, useCount: 0,
      });
      // 冲突用「新增 + supersede」而不是原地改：保留可解释、可撤销的链路
      for (const old of await opts.store.findBySubject('user', key, k)) {
        if (old.id !== id) await opts.store.supersede(old.id, id);
      }
      return `已记住：${text}`;
    },
  });

  const recall = defineTool<{ query: string }>({
    id: BUILTIN_TOOLS.MEMORY_RECALL,
    description: '在长期记忆里查找关于用户的事（偏好、常用的人和地址、做事习惯）。上下文里已经列出的不用再查。',
    input: { query: { type: 'string', description: '关键词' } },
    when: on,
    async run({ query }) {
      const hits = (await opts.store.search({ scope: 'user', text: String(query ?? ''), limit: 10 })).map((s) => s.item);
      if (hits.length === 0) return '没有相关的记忆。';
      await opts.store.touch(hits.map((m) => m.id), opts.now());
      return hits.map((m) => `- ${m.statement}`).join('\n');
    },
  });

  const forget = defineTool<{ query: string }>({
    id: BUILTIN_TOOLS.MEMORY_FORGET,
    description: '按用户的要求删掉长期记忆里的某条内容。query 写要删的那条记忆里的关键词。删除不能撤销，执行前会问用户。',
    input: { query: { type: 'string', description: '要删的那条记忆里的关键词' } },
    // 不可撤销：三档策略下都要确认；也不给「始终允许」
    risk: 'irreversible',
    triggers: MEMORY_FORGET_TRIGGERS,
    when: on,
    async run({ query }) {
      const hits = (await opts.store.search({ scope: 'user', text: String(query ?? ''), limit: 5 })).map((s) => s.item);
      if (hits.length === 0) return '没有找到相关的记忆，什么都没删。';
      await opts.purger.purge({
        refs: hits.map((m) => ({ kind: 'memory', ref: m.id })),
        motive: 'privacy', reason: '用户在对话里要求忘掉',
      });
      return `已忘掉 ${hits.length} 条：${hits.map((m) => `「${m.statement}」`).join('、')}`;
    },
  });

  // 技能 id 单独一个（工具 id 仍是 builtin.memory_*）：定制 Agent 可以不给记忆 —— 比如写小说的 Agent 不该把人物设定记成用户的偏好
  return defineBuiltinSkill({
    id: 'memory',
    name: '记忆',
    purpose: '用户让你记住某件事、或提到之前说过的偏好时使用',
    tools: [write, recall, forget],
  });
}
