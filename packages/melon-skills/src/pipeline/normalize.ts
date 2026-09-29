import type {
  ArtifactRef, ToolContext, ToolMetrics, ToolOutput, ToolResult, ToolErrorShape,
} from '@melon-ai/core';

/** summary 是唯一保证进上下文的字段，必须有硬上限。按字符算，约 512 token。 */
export const SUMMARY_CHAR_LIMIT = 2048;
export const TRUNCATION_MARKER = '…【已截断，完整内容见 artifact】';

export interface NormalizeInput {
  readonly output: ToolOutput;
  readonly metrics: ToolMetrics;
  readonly cx: ToolContext;
}

/**
 * 归一化：把工具的原始返回包成统一信封。
 *
 * 两条硬约束：
 * 1. **大结果永不进上下文。** summary 超限就截断，并把完整文本落成 artifact ——
 *    截断必须可见（留标记）且无损（原文可取回），不能悄悄丢。
 * 2. **错误码必须对模型可操作。** 见 errors.ts。
 */
export async function normalizeOk(input: NormalizeInput): Promise<ToolResult> {
  const { output, metrics, cx } = input;
  let summary = output.summary;
  let artifactRef: ArtifactRef | undefined = output.artifactRef;

  if (summary.length > SUMMARY_CHAR_LIMIT) {
    // 原文不能丢：没有 artifact 就现场落一个
    if (artifactRef === undefined) {
      artifactRef = await cx.putArtifact(summary, {
        mime: 'text/plain',
        summary: `被截断的工具输出（原长 ${summary.length} 字符）`,
      });
    }
    summary = summary.slice(0, SUMMARY_CHAR_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }

  const base = { ok: true as const, summary, metrics };
  return {
    ...base,
    ...(output.data !== undefined ? { data: output.data } : {}),
    ...(artifactRef !== undefined ? { artifactRef } : {}),
  };
}

export function normalizeErr(error: ToolErrorShape, metrics: ToolMetrics): ToolResult {
  return {
    ok: false,
    // 错误也要有 summary —— 它会作为 observation 回喂给模型
    summary: `调用失败（${error.code}）：${error.message}${error.hint ? `。建议：${error.hint}` : ''}`,
    error,
    metrics,
  };
}

export const emptyMetrics = (ms = 0): ToolMetrics => ({ ms, bytes: 0, retries: 0 });
