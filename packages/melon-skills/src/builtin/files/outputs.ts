import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { SkillProvider } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { defineBuiltinSkill, defineTool } from '../../registry/define.js';

/** 能生成的文件类型：都是文本。Word / Excel 以后加（要再引依赖）。 */
const EXTS = new Set(['.md', '.txt', '.csv', '.json', '.html']);

/** 文件名只留安全的部分：不能带路径、不能以点开头。 */
function safeName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().replace(/^\.+/, '');
  return base.slice(0, 120);
}

/**
 * 「生成文件」：Agent 把整理好的内容写成文件（Markdown、CSV、文本……），放在宿主给的输出目录里（每个任务一个子目录）。
 * **不往用户的文件夹里写** —— 存到哪里由用户在宿主界面上「另存为」决定，所以按本地写入处理（不用每次问）。
 * 结果带上生成的文件（`ToolOutput.files`），宿主在对话里显示文件卡片。
 */
export function outputs(opts: { dir: string }): SkillProvider {
  const write = defineTool<{ name: string; content: string }>({
    id: 'output.write',
    description: '把内容写成一个文件给用户（.md / .csv / .txt / .json / .html）。用户要「生成一份文件」「导出成表格」「存成文档」时用；'
      + '文件放在应用的输出区，用户自己决定另存到哪里。表格用 CSV（逗号分隔，第一行是表头）。',
    risk: 'write',
    triggers: ['生成文件', '导出成', '存成文件', '保存成文件', '做成表格文件'],
    input: {
      name: { type: 'string', description: '文件名，带扩展名，如 九月费用汇总.csv' },
      content: { type: 'string', description: '文件的完整内容' },
    },
    run: async ({ name, content }, cx) => {
      const file = safeName(name);
      if (!file || !EXTS.has(extname(file).toLowerCase())) {
        throw new ToolError('INVALID_ARGS', `文件名不行：${name}`, { hint: `用这些扩展名之一：${[...EXTS].join(' ')}` });
      }
      const dir = join(opts.dir, String(cx.taskId));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, file);
      // CSV 加 BOM：Excel 直接打开中文不乱码
      writeFileSync(path, extname(file).toLowerCase() === '.csv' && !content.startsWith('﻿') ? `﻿${content}` : content, 'utf8');
      const size = statSync(path).size;
      return { summary: `已生成文件 ${file}（${size} 字节）。用户可以在对话里打开或另存。`, files: [{ name: file, path, size }] };
    },
  });
  return defineBuiltinSkill({ id: 'output', name: '生成文件', purpose: '需要把整理好的内容做成一个文件给用户时使用', tools: [write] });
}
