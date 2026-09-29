import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillBundle, SkillProvider, ToolContext } from '@melon-ai/core';
import { asSkillId, asToolId } from '@melon-ai/core';
import { newTask } from '@melon-ai/testkit';
import { ToolRegistry, basicValidator, defineTool, toSchema } from '../../src/index.js';

const cx = {} as ToolContext;

test('defineTool：简写生成 JSON Schema，技能 id 取点号前', () => {
  const t = defineTool({
    id: 'mail.send', description: '发邮件', risk: 'external', scope: ['to'],
    input: { to: 'string', body: 'string?', days: 'integer[]', level: { type: 'string', enum: ['a', 'b'], optional: true } },
    run: () => 'ok',
  });
  assert.equal(t.descriptor.skillId, 'mail');
  assert.equal(t.descriptor.name, 'send');
  assert.equal(t.descriptor.idempotent, false, '非 read 默认不幂等');
  assert.deepEqual(t.descriptor.scopeKeys, ['to']);
  assert.deepEqual(t.descriptor.input, {
    type: 'object',
    properties: {
      to: { type: 'string' }, body: { type: 'string' },
      days: { type: 'array', items: { type: 'integer' } }, level: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['to', 'days'],
  });
});

test('defineTool：id 必须是「技能.名字」', () => {
  assert.throws(() => defineTool({ id: 'send', description: '', run: () => '' }), /技能\.名字/);
});

test('defineTool：run 返回字符串即 summary', async () => {
  const t = defineTool({ id: 'x.y', description: '', run: ({ n }: { n: number }) => `n=${n}` });
  assert.deepEqual(await t.handler({ n: 1 }, cx), { summary: 'n=1' });
  assert.equal(t.descriptor.idempotent, true, 'read 默认幂等');
});

test('完整 JSON Schema 原样使用', () => {
  const s = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  assert.equal(toSchema(s), s);
});

test('默认校验器：必填、类型（数组的 typeof 是 object）、枚举、数组元素、范围', () => {
  const schema = toSchema({ to: 'string', days: 'integer[]', mode: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer', minimum: 1, maximum: 3 } });
  assert.deepEqual(basicValidator.validate(schema, { to: 'x', days: [1, 5], mode: 'a', n: 2 }), []);
  const issues = basicValidator.validate(schema, { days: [1, 'x'], mode: 'c', n: 9 }).map((i) => i.path).sort();
  assert.deepEqual(issues, ['/days/1', '/mode', '/n', '/to']);
});

const provider = (tools: string[]): SkillProvider & { fire(): void; set(t: string[]): void } => {
  let names = tools;
  const subs = new Set<() => void>();
  return {
    id: 'p',
    async list(): Promise<readonly SkillBundle[]> {
      return [{
        skill: {
          id: asSkillId('web'), name: 'web', purpose: '', keywords: [], source: { kind: 'builtin' },
          tools: names.map((n) => ({ id: asToolId(n), skillId: asSkillId('web'), name: n, description: n, input: {}, risk: 'read' as const, idempotent: true })),
        },
        handlers: new Map(names.map((n) => [n, async () => ({ summary: `from ${n}` })])),
      }];
    },
    async health() { return { status: 'up' as const }; },
    onChange(cb) { subs.add(cb); return () => subs.delete(cb); },
    fire() { for (const cb of subs) cb(); },
    set(t) { names = t; },
  };
};

test('注册表：合并宿主工具与技能来源；宿主同名工具优先', async () => {
  const p = provider(['web.search', 'web.fetch']);
  const mine = defineTool({ id: 'web.fetch', description: '宿主自己的', run: () => 'mine' });
  const r = new ToolRegistry({ tools: [mine], providers: [p] });
  await r.ready();
  assert.deepEqual(r.list().map((d) => d.id).sort(), ['web.fetch', 'web.search']);
  const fetch = await r.resolve(asToolId('web.fetch'));
  assert.deepEqual(await fetch!.handler({}, cx), { summary: 'mine' });
  assert.equal(await r.isEnabledFor(asToolId('nope.x')), false);
});

test('注册表：来源通知变化后工具集跟着变', async () => {
  const p = provider(['web.fetch']);
  const r = new ToolRegistry({ providers: [p] });
  await r.ready();
  p.set(['web.fetch', 'web.search']);
  p.fire();
  await r.ready();
  assert.equal(await r.isEnabledFor(asToolId('web.search')), true);
});

test('注册表：when 不满足的工具不给模型；schema 带 additionalProperties:false', () => {
  const chatOnly = defineTool({ id: 'task.propose', description: '', when: (t) => t.trigger.ref === 'chat', run: () => '' });
  const always = defineTool({ id: 'doc.read', description: '', input: { q: 'string' }, run: () => '' });
  const r = new ToolRegistry({ tools: [chatOnly, always] });
  assert.deepEqual(r.modelTools(newTask()).map((t) => t.name), ['doc.read']);
  assert.deepEqual(r.modelTools(newTask({ trigger: { type: 'manual', ref: 'chat' } })).map((t) => t.name).sort(), ['doc.read', 'task.propose']);
  assert.equal(r.modelTools(newTask())[0]!.input['additionalProperties'], false);
});

test('注册表：setTools 热替换；重复 id 直接拒绝', () => {
  const r = new ToolRegistry();
  r.setTools([defineTool({ id: 'a.b', description: '', run: () => '' })]);
  assert.equal(r.list().length, 1);
  assert.throws(() => r.setTools([
    defineTool({ id: 'a.b', description: '', run: () => '' }),
    defineTool({ id: 'a.b', description: '', run: () => '' }),
  ]), /重复/);
});
