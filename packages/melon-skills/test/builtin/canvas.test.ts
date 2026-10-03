import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, diffPaths } from '../../src/index.js';

test('画布的改法：add / replace / remove / move 按 JSON Pointer 定位；不改原对象；路径不对报清楚', () => {
  const doc = { list: [{ t: 'a' }, { t: 'b' }], 'x/y': 1 };
  const out = applyPatch(doc, [
    { op: 'add', path: '/list/-', value: { t: 'c' } },
    { op: 'replace', path: '/list/0/t', value: 'A' },
    { op: 'move', from: '/list/2', path: '/list/1' },
    { op: 'remove', path: '/x~1y' },
    { op: 'add', path: '/meta', value: { n: 1 } },
  ]);
  assert.deepEqual(out, { list: [{ t: 'A' }, { t: 'c' }, { t: 'b' }], meta: { n: 1 } });
  assert.deepEqual(doc, { list: [{ t: 'a' }, { t: 'b' }], 'x/y': 1 }, '原对象不动');
  assert.deepEqual(applyPatch(null, [{ op: 'replace', path: '', value: { a: 1 } }]), { a: 1 }, '空画布第一次整份生成');
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: '/list/5', value: 1 }]), /下标越界/);
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: '/nope', value: 1 }]), /没有这个字段/);
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: 'list', value: 1 }]), /要以 \/ 开头/);
  assert.throws(() => applyPatch(doc, [{ op: 'copy' as never, path: '/a' }]), /不认识的操作/);
});

test('diffPaths：说清楚改了哪里（给模型看）', () => {
  assert.deepEqual(diffPaths({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), ['/b/1']);
  assert.deepEqual(diffPaths({ a: 1 }, { a: 1 }), []);
});
