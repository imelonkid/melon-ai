import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defaultPlatform, sha256Hex } from '../src/index.js';

test('默认平台的 SHA-256 与 node:crypto 一致（空串、中文、跨块边界的长度）', () => {
  const inputs = ['', 'abc', '发邮件给 a@b.com', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '长'.repeat(1000)];
  for (const s of inputs) assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), `长度 ${s.length}`);
  assert.match(defaultPlatform().ids.next('task'), /^task-[0-9a-f-]{36}$/);
});

test('根入口不引用 node:* —— 非 Node 宿主也能 import @melon-ai/agent（§2.8）', () => {
  const nodeOnly = new Set(['node.ts', 'sqlite.ts', 'web.ts', 'mail.ts', 'agentskills.ts', 'anthropic.ts']);
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts') && !nodeOnly.has(f))) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /from 'node:|\bprocess\./, f);
  }
});
