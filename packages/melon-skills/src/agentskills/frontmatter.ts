/**
 * `SKILL.md` 的 YAML frontmatter 解析。
 *
 * 只支持 frontmatter 实际会用到的子集：`key: value`（可带引号）、`|` / `>` 块、
 * 一层嵌套的映射（`metadata:`）、列表（`- a` 或 `[a, b]`）。不引 YAML 库 ——
 * 完整 YAML 的复杂度（锚点、标签、类型推断）在这里全用不上，反而是攻击面。
 *
 * **从宽**（按 agentskills.io 的接入指南）：别的客户端写的技能常有不严格的 YAML，
 * 最常见的是值里带冒号却没加引号（`description: Use when: …`）—— 按第一个冒号切，
 * 后面整段当值，不报错。
 */
export type FrontValue = string | readonly string[] | Readonly<Record<string, string>>;

export interface Parsed {
  readonly fields: Readonly<Record<string, FrontValue>>;
  readonly body: string;
}

const unquote = (v: string): string => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return t;
};

const indentOf = (l: string): number => l.length - l.trimStart().length;

/** 解析失败（没有 frontmatter、分隔符不闭合）返回 null。 */
export function parseSkillMd(src: string): Parsed | null {
  const text = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n') && text !== '---') return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const head = text.slice(4, end);
  const after = text.slice(end + 4);
  const body = after.replace(/^[^\n]*\n?/, '').trim();

  const lines = head.split('\n');
  const fields: Record<string, FrontValue> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#') || indentOf(line) > 0) { i++; continue; }
    const colon = line.indexOf(':');
    if (colon <= 0) { i++; continue; }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    i++;

    // 块标量：| 保留换行，> 折叠成空格
    if (/^[|>][-+]?$/.test(rest)) {
      const block: string[] = [];
      while (i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) > 0)) block.push(lines[i++]!);
      const pad = Math.min(...block.filter((l) => l.trim()).map(indentOf), Infinity);
      const raw = block.map((l) => l.slice(Number.isFinite(pad) ? pad : 0));
      fields[key] = (rest.startsWith('|') ? raw.join('\n') : raw.join(' ').replace(/\s+/g, ' ')).trim();
      continue;
    }
    // 行内列表
    if (rest.startsWith('[') && rest.endsWith(']')) {
      fields[key] = rest.slice(1, -1).split(',').map(unquote).filter(Boolean);
      continue;
    }
    if (rest === '') {
      // 下面缩进的是列表或映射
      const children: string[] = [];
      while (i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) > 0)) children.push(lines[i++]!);
      const items = children.filter((l) => l.trim());
      if (items.length > 0 && items.every((l) => l.trim().startsWith('- '))) {
        fields[key] = items.map((l) => unquote(l.trim().slice(2)));
      } else {
        const map: Record<string, string> = {};
        for (const l of items) {
          const c = l.indexOf(':');
          if (c > 0) map[l.slice(0, c).trim()] = unquote(l.slice(c + 1));
        }
        fields[key] = map;
      }
      continue;
    }
    // 普通标量：可能跨行续写（缩进的后续行）
    let value = rest;
    while (i < lines.length && lines[i]!.trim() !== '' && indentOf(lines[i]!) > 0) value += ` ${lines[i++]!.trim()}`;
    fields[key] = unquote(value);
  }
  return { fields, body };
}

export const asString = (v: FrontValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
