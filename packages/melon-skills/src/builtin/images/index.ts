/**
 * `@melon-ai/skills/images` —— 内置技能「生成图片」：按描述画图，图片存进宿主给的输出目录（每个任务一个子目录），
 * 作为「生成的文件」交给宿主（`ToolOutput.files`），宿主在对话里直接显示。
 *
 * 单独一个子路径：要写文件（Node）。厂商实现（`ImageGenerator`）在 `@melon-ai/plugins` 里，宿主按需引入。
 *
 * - 描述会发给生图厂商：按对外操作处理（第一次先问，可以始终允许）。
 * - 按次计费：每次真的生成都记进用量账本（`billing`，免费的记 0 元），宿主的用量页看得到。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageGenerator, SkillProvider } from '@melon-ai/core';
import { ToolError } from '@melon-ai/core';
import { defineBuiltinSkill, defineTool } from '../../registry/define.js';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 文件名用描述的开头（去掉不能出现在文件名里的字符）。 */
const nameOf = (prompt: string): string => String(prompt).replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 24) || '图片';

export interface ImagesOptions {
  readonly generator: ImageGenerator;
  /** 生成的图片放在这里（每个任务一个子目录）。 */
  readonly dir: string;
}

export function images(opts: ImagesOptions): SkillProvider {
  const g = opts.generator;
  const generate = defineTool<{ prompt: string; size?: string }>({
    id: 'image.generate',
    description: `按描述生成图片（${g.label}）。用户要「画一张」「生成一张图 / 海报 / 插画 / 头像」时用。`
      + 'prompt 写具体：主体、场景、风格、构图、颜色；图里要有文字的把文字原样写进去并加引号。生成好的图片会直接显示给用户，回答里不用再描述它长什么样。',
    risk: 'external',
    triggers: ['画一张', '画一幅', '画个', '画一个', '生成一张', '生成图片', '生成一张图', '做一张海报', '画张', '出一张图', '画图'],
    input: {
      prompt: { type: 'string', description: '画什么：主体、场景、风格、构图、颜色，越具体越好' },
      size: { type: 'string', enum: [...g.sizes], optional: true, description: `尺寸，默认 ${g.sizes[0]}（方图）。竖图选高大于宽的，横图反之` },
    },
    // 按次计费：免费的也记一笔（0 元），用量页能看到画了几张
    ...(g.price ? { billing: { vendor: g.vendor, perCall: g.price } } : { billing: { vendor: g.vendor } }),
    run: async ({ prompt, size }, cx) => {
      if (!String(prompt ?? '').trim()) throw new ToolError('INVALID_ARGS', 'prompt 不能为空', { hint: '写清楚要画什么' });
      const imgs = await g.generate({ prompt, ...(size ? { size } : {}) }, cx.signal);
      const dir = join(opts.dir, String(cx.taskId));
      mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const files = imgs.map((img, i) => {
        const name = `${nameOf(prompt)}-${stamp}${imgs.length > 1 ? `-${i + 1}` : ''}.${EXT[img.mime] ?? 'png'}`;
        const path = join(dir, name);
        writeFileSync(path, img.data);
        return { name, path, size: img.data.length };
      });
      const cost = g.price ? (g.price.amount === 0 ? '免费' : `${g.price.amount} 元/张`) : '';
      return {
        summary: `已生成 ${files.length} 张图片（${g.label}${size ? ` · ${size}` : ''}${cost ? ` · ${cost}` : ''}）：${files.map((f) => f.name).join('、')}。图片已经显示给用户了，不用再描述它。`,
        files,
      };
    },
  });
  return defineBuiltinSkill({ id: 'image', name: '生成图片', purpose: '需要画图、生成插画 / 海报 / 头像 / 示意图时使用', tools: [generate] });
}
