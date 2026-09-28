import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Grant, PolicyMode, RiskClass, ToolDescriptor } from '@melon-ai/core';
import {
  ADMISSION_MATRIX, BUILTIN_TOOLS, asAgentId, asSkillId, asToolId,
} from '@melon-ai/core';
import { SCOPE_ANY, computeScope, decide, grantFrom } from '../src/index.js';
import type { DecideInput } from '../src/index.js';

const AGENT = asAgentId('a1');
const MAIL = asToolId('mail.send');
const MODES: PolicyMode[] = ['ask', 'low-risk-auto', 'all-auto'];
const RISKS: RiskClass[] = ['read', 'write', 'external', 'spend', 'irreversible'];

const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  agentId: AGENT, toolId: MAIL, risk: 'external', scope: 'to=产品组',
  mode: 'ask', tainted: false, skillEnabled: true, grant: null, quota: null, now: 1000,
  ...over,
});

// ───────────────────────── 矩阵 ─────────────────────────

test('矩阵被完整遍历，实现与表一致', () => {
  for (const mode of MODES) {
    for (const risk of RISKS) {
      const r = decide(input({ mode, risk }));
      assert.equal(r.decision, ADMISSION_MATRIX[mode][risk], `${mode} × ${risk}`);
      assert.equal(r.basis.gate, 'matrix');
    }
  }
});

test('「全部自动」也不放开花钱和不可撤销 —— 这条不能回归', () => {
  for (const risk of ['spend', 'irreversible'] as const) {
    assert.equal(decide(input({ mode: 'all-auto', risk })).decision, 'ask',
      `all-auto 下 ${risk} 必须仍然询问`);
  }
});

// ───────────────────────── 闸门顺序 ─────────────────────────

test('未开启的技能直接拒，不走到「问用户」', () => {
  const r = decide(input({ skillEnabled: false, mode: 'ask' }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.basis.gate, 'authorization');
});

test('配额早于矩阵：配额爆了不该先问用户再失败', () => {
  const r = decide(input({
    mode: 'ask', risk: 'external',
    quota: { window: 'month', usedUSD: 100, limitUSD: 100, usedCalls: 0, limitCalls: 999 },
  }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.basis.gate, 'quota');
  assert.equal(r.basis.quotaKind, 'cost');
});

test('调用次数配额同样拦', () => {
  const r = decide(input({
    quota: { window: 'day', usedUSD: 0, limitUSD: 100, usedCalls: 50, limitCalls: 50 },
  }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.basis.quotaKind, 'calls');
});

// ───────────────────────── 授权 ─────────────────────────

test('命中 always 授权则放行，绕过矩阵', () => {
  const g: Grant = { agentId: AGENT, toolId: MAIL, scope: 'to=产品组', grantedAt: 0 };
  const r = decide(input({ mode: 'ask', risk: 'external', grant: g }));
  assert.equal(r.decision, 'allow');
  assert.equal(r.basis.gate, 'grant');
  assert.equal(r.matchedGrant, g);
});

test('范围不同的授权不匹配 —— 「发给产品组」不等于「发给任何人」', () => {
  const g: Grant = { agentId: AGENT, toolId: MAIL, scope: 'to=产品组', grantedAt: 0 };
  const r = decide(input({ mode: 'ask', grant: g, scope: 'to=全体员工' }));
  assert.equal(r.decision, 'ask', '换了收件人必须重新确认');
  assert.equal(r.basis.gate, 'matrix');
});

test('别的 agent 的授权不匹配', () => {
  const g: Grant = { agentId: asAgentId('other'), toolId: MAIL, scope: 'to=产品组', grantedAt: 0 };
  assert.equal(decide(input({ grant: g })).decision, 'ask');
});

test('过期授权落回矩阵，而不是当成拒绝', () => {
  const g: Grant = { agentId: AGENT, toolId: MAIL, scope: 'to=产品组', grantedAt: 0, expiresAt: 500 };
  const r = decide(input({ grant: g, now: 1000, mode: 'low-risk-auto', risk: 'read' }));
  assert.equal(r.decision, 'allow', '过期只是失去捷径，read 在该策略下本就自动');
  assert.equal(r.basis.gate, 'matrix');
});

// ───────────────────── 污点覆盖（关键） ─────────────────────

test('污点覆盖 grant —— 攻击路径正是靠 grant 自动放行', () => {
  const g: Grant = {
    agentId: AGENT, toolId: BUILTIN_TOOLS.MEMORY_WRITE, scope: SCOPE_ANY, grantedAt: 0,
  };
  const r = decide(input({
    toolId: BUILTIN_TOOLS.MEMORY_WRITE, risk: 'write', scope: SCOPE_ANY,
    mode: 'all-auto', tainted: true, grant: g,
  }));
  assert.equal(r.decision, 'ask', '有 always 授权也必须问');
  assert.equal(r.basis.gate, 'taint');
  assert.equal(r.basis.overrode, 'grant');
});

test('污点下 all-auto 也不能自动写记忆', () => {
  const r = decide(input({
    toolId: BUILTIN_TOOLS.MEMORY_WRITE, risk: 'write', mode: 'all-auto', tainted: true,
  }));
  assert.equal(r.decision, 'ask');
  assert.equal(r.basis.overrode, 'matrix');
});

test('污点只作用于写持久状态的工具，读记忆不受影响', () => {
  const r = decide(input({
    toolId: BUILTIN_TOOLS.MEMORY_RECALL, risk: 'read', mode: 'low-risk-auto', tainted: true,
  }));
  assert.equal(r.decision, 'allow', '污点不该把只读也拦住，否则 Agent 在污染后完全瘫痪');
});

test('污点也覆盖 memory_forget', () => {
  const r = decide(input({
    toolId: BUILTIN_TOOLS.MEMORY_FORGET, risk: 'irreversible', mode: 'all-auto', tainted: true,
  }));
  assert.equal(r.decision, 'ask');
  assert.equal(r.basis.gate, 'taint');
});

test('未污染时 memory_write 走正常矩阵', () => {
  const r = decide(input({
    toolId: BUILTIN_TOOLS.MEMORY_WRITE, risk: 'write', mode: 'low-risk-auto', tainted: false,
  }));
  assert.equal(r.decision, 'allow');
  assert.equal(r.basis.gate, 'matrix');
});

// ───────────────────────── scope 计算 ─────────────────────────

const desc = (scopeKeys?: readonly string[]): ToolDescriptor => ({
  id: MAIL, skillId: asSkillId('mail'), name: 'send', description: '',
  input: {}, risk: 'external', idempotent: false,
  ...(scopeKeys !== undefined ? { scopeKeys } : {}),
});

test('scope 只取声明的参数，其余变化不影响授权', () => {
  const d = desc(['to']);
  const a = computeScope(d, { to: '产品组', subject: '周报', body: 'x' });
  const b = computeScope(d, { to: '产品组', subject: '月报', body: 'y' });
  assert.equal(a, 'to=产品组');
  assert.equal(a, b, '同一收件人、不同主题应命中同一条授权');
});

test('未声明 scopeKeys 的工具 scope 为 *', () => {
  assert.equal(computeScope(desc(), { anything: 1 }), SCOPE_ANY);
});

test('scope 是人可读的 —— 设置页要能复核，审计要能直接看懂', () => {
  const s = computeScope(desc(['to', 'cc']), { to: '产品组', cc: ['张三', '李四'] });
    assert.equal(s, 'to=产品组&cc=[张三,李四]');
  assert.ok(!/^[0-9a-f]{32,}$/.test(s), 'scope 不该是哈希');
});

test('对象参数的 scope 稳定：键序不同结果相同', () => {
  const d = desc(['filter']);
  assert.equal(
    computeScope(d, { filter: { b: 2, a: 1 } }),
    computeScope(d, { filter: { a: 1, b: 2 } }),
  );
});

test('grantFrom 带 ttl 时写入过期时间', () => {
  const g = grantFrom(input(), 1000, 60_000);
  assert.equal(g.expiresAt, 61_000);
  assert.equal(g.scope, 'to=产品组');
  assert.equal(grantFrom(input(), 1000).expiresAt, undefined);
});
