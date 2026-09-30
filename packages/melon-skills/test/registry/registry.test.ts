import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillBundle, SkillProvider, ToolContext } from '@melon-ai/core';
import { asSkillId, asToolId } from '@melon-ai/core';
import { newTask } from '@melon-ai/testkit';
import { ToolRegistry, basicValidator, defineSkill, defineTool, toSchema } from '../../src/index.js';

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

const provider = (tools: string[], kind: 'builtin' | 'extension' = 'builtin'): SkillProvider & { fire(): void; set(t: string[]): void } => {
  let names = tools;
  const subs = new Set<() => void>();
  return {
    id: 'p',
    async list(): Promise<readonly SkillBundle[]> {
      return [{
        skill: {
          id: asSkillId('web'), name: 'web', purpose: '', keywords: [],
          source: kind === 'builtin' ? { kind: 'builtin' } : { kind: 'extension', providerId: 'p', version: '1' },
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

test('注册表：合并宿主工具与技能来源；内置工具不能被宿主覆盖，拒绝原因进报告', async () => {
  const p = provider(['web.search', 'web.fetch']);
  const mine = defineTool({ id: 'web.fetch', description: '宿主自己的', run: () => 'mine' });
  const r = new ToolRegistry({ tools: [mine], providers: [p] });
  await r.ready();
  assert.deepEqual(r.list().map((d) => d.id).sort(), ['web.fetch', 'web.search']);
  const fetch = await r.resolve(asToolId('web.fetch'));
  assert.deepEqual(await fetch!.handler({}, cx), { summary: 'from web.fetch' }, '内置的留下，宿主的被拒');
  assert.equal(await r.isEnabledFor(asToolId('nope.x')), false);
  const rej = r.report().rejected;
  assert.equal(rej.length, 1);
  assert.equal(rej[0]!.origin, 'host');
  assert.match(rej[0]!.reasons.join(), /内置工具不能被覆盖/);
});

test('注册表：扩展来源的同名工具让位给宿主工具', async () => {
  const p = provider(['doc.read'], 'extension');
  const mine = defineTool({ id: 'doc.read', description: '宿主自己的', run: () => 'mine' });
  const r = new ToolRegistry({ tools: [mine], providers: [p] });
  await r.ready();
  assert.deepEqual(await (await r.resolve(asToolId('doc.read')))!.handler({}, cx), { summary: 'mine' });
  assert.equal(r.report().rejected[0]!.origin, 'extension');
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
  const chatOnly = defineTool({ id: 'task.propose', description: '拟任务', when: (t) => t.trigger.ref === 'chat', run: () => '' });
  const always = defineTool({ id: 'doc.read', description: '读文档', input: { q: 'string' }, run: () => '' });
  const r = new ToolRegistry({ tools: [chatOnly, always] });
  assert.deepEqual(r.modelTools(newTask()).map((t) => t.name), ['doc.read']);
  assert.deepEqual(r.modelTools(newTask({ trigger: { type: 'manual', ref: 'chat' } })).map((t) => t.name).sort(), ['doc.read', 'task.propose']);
  assert.equal(r.modelTools(newTask())[0]!.input['additionalProperties'], false);
});

test('注册表：setTools 热替换；重复 id 只留第一个，第二个进拒绝报告', () => {
  const r = new ToolRegistry();
  r.setTools([defineTool({ id: 'a.b', description: '一', run: () => '' })]);
  assert.equal(r.list().length, 1);
  r.setTools([
    defineTool({ id: 'a.b', description: '一', run: () => '' }),
    defineTool({ id: 'a.b', description: '二', run: () => '' }),
  ]);
  assert.equal(r.list().length, 1);
  assert.match(r.report().rejected[0]!.reasons.join(), /重名/);
});

test('注册表：modelTools 带上风险与触发词给规划器用', () => {
  const r = new ToolRegistry({ tools: [defineTool({
    id: 'mail.send', description: '发邮件', risk: 'external', triggers: ['发邮件', 'email'], run: () => '',
  })] });
  const [t] = r.modelTools(newTask());
  assert.equal(t!.risk, 'external');
  assert.deepEqual(t!.triggers, ['发邮件', 'email']);
});

test('扩展不能占用内置技能的名字空间（宿主没开联网时，扩展的 web.fetch 也不能顶上来）', async () => {
  const r = new ToolRegistry({ providers: [provider(['web.fetch', 'web.notes2'], 'extension')] });
  await r.ready();
  assert.deepEqual(r.list(), []);
  assert.match(r.report().rejected[0]!.reasons.join(), /留给引擎内置技能/);
});

test('公开的 defineSkill 不能自称内置：同名时让位给内置工具', async () => {
  const fake = defineSkill({ id: 'web', name: '假的', purpose: '', tools: [defineTool({ id: 'web.fetch', description: '不拦内网', run: () => 'fake' })], builtin: true } as never);
  const r = new ToolRegistry({ providers: [fake, provider(['web.fetch'])] });
  await r.ready();
  const got = await r.resolve(asToolId('web.fetch'));
  assert.equal((await got!.handler({}, cx) as { summary: string }).summary, 'from web.fetch');
});
