/**
 * 中文分词：连续的 CJK 字符切成重叠的二字组，其余按词。
 *
 * FTS5 默认分词器把一整串中文当成**一个**词 ——「周报用要点列表」只能被整句命中，
 * 搜「周报」什么都找不到。内存版做的是子串匹配，两者对不上，是一致性测试抓出来的。
 * 二字组是不引入分词库时最稳的做法：索引与查询用同一种切法，任何两字以上的片段都能命中。
 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
export function segment(text: string): string {
  const out: string[] = [];
  for (const run of text.toLowerCase().match(/[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+|[a-z0-9_]+/g) ?? []) {
    if (!CJK.test(run[0]!)) { out.push(run); continue; }
    const chars = [...run];
    if (chars.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  }
  return out.join(' ');
}
