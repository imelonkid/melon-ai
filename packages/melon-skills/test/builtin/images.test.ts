import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageGenerator, ToolContext, ToolHandler } from '@melon-ai/core';
import { images } from '../../src/builtin/images/index.js';

const cx = (): ToolContext => ({
  taskId: 't1' as never, callId: 'c' as never, trace: {} as never, signal: new AbortController().signal,
  putArtifact: async () => 'a' as never, readArtifact: async () => '', log: () => {},
});

test('生成图片：按描述生成，存进输出目录（每任务一个子目录），结果带上文件；对外操作、按次计费；尺寸只能选厂商支持的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const asked: unknown[] = [];
  const g: ImageGenerator = {
    vendor: 'zhipu', model: 'cogview-3-flash', label: 'CogView-3-Flash（免费）', price: { amount: 0, currency: 'CNY' },
    sizes: ['1024x1024', '768x1344'],
    generate: async (req) => { asked.push(req); return [{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' }]; },
  };
  try {
    const [b] = await images({ generator: g, dir }).list();
    const d = b!.skill.tools.find((t) => t.id === 'image.generate')!;
    assert.equal(d.risk, 'external', '描述发给厂商：要问');
    assert.deepEqual(d.billing, { vendor: 'zhipu', perCall: { amount: 0, currency: 'CNY' } });
    assert.deepEqual((d.input['properties'] as Record<string, { enum?: string[] }>)['size']!.enum, ['1024x1024', '768x1344']);
    assert.ok(d.triggers!.includes('画一张'));
    const r = await (b!.handlers.get('image.generate') as ToolHandler)({ prompt: '一只在海边看日落的橘猫，水彩风', size: '768x1344' }, cx());
    assert.deepEqual(asked, [{ prompt: '一只在海边看日落的橘猫，水彩风', size: '768x1344' }]);
    assert.equal(r.files!.length, 1);
    assert.ok(r.files![0]!.path.startsWith(join(dir, 't1')));
    assert.match(r.files![0]!.name, /^一只在海边看日落的橘猫，水彩风-\d+\.png$/);
    assert.deepEqual([...readFileSync(r.files![0]!.path)], [0x89, 0x50, 0x4e, 0x47]);
    assert.match(r.summary, /已生成 1 张图片（CogView-3-Flash（免费） · 768x1344 · 免费）/);
    assert.match(r.summary, /不用再描述它/);
    assert.ok(existsSync(r.files![0]!.path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
