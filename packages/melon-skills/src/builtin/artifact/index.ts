import type { SkillProvider } from '@melon-ai/core';
import { BUILTIN_TOOLS, asArtifactRef } from '@melon-ai/core';
import { defineSkill, defineTool } from '../../registry/define.js';

/** 一次读回的上限。更大的内容分段读（offset）。 */
const CHUNK = 8000;

/**
 * 内置技能：按句柄读取完整内容。
 *
 * 工具返回的大结果（网页全文、长文档）只把开头放进摘要，全文存成 artifact，
 * 摘要里带着句柄 —— 模型需要细节时用这个工具取。只能读本任务产生的 artifact
 * （管线的 `readArtifact` 会校验），句柄是可猜的，不能跨任务读。
 */
export const artifactRead = defineTool<{ ref: string; offset?: number }>({
  // 沿用 core 约定的内置工具 id（BUILTIN_TOOLS.ARTIFACT_READ），上下文里的提示也引用它
  id: BUILTIN_TOOLS.ARTIFACT_READ,
  description: '按句柄读取此前工具返回的完整内容。摘要里写了「完整内容句柄」、又需要摘要以外的细节时才用；内容很长时用 offset 分段读。',
  input: {
    ref: { type: 'string', description: '句柄，形如 art-…' },
    offset: { type: 'integer', optional: true, minimum: 0, description: '从第几个字符开始读，默认 0' },
  },
  async run({ ref, offset = 0 }, cx) {
    const text = await cx.readArtifact(asArtifactRef(ref));
    const part = text.slice(offset, offset + CHUNK);
    const rest = text.length - (offset + part.length);
    return rest > 0 ? `${part}\n…（还有 ${rest} 字，用 offset=${offset + part.length} 接着读）` : part;
  },
});

export function artifact(): SkillProvider {
  return defineSkill({
    id: 'builtin',
    name: '完整内容',
    purpose: '需要读取工具结果的完整内容（摘要里给了句柄）时使用',
    tools: [artifactRead],
    builtin: true,
  });
}
