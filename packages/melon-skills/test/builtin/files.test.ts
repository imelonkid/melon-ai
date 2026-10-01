import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import type { ToolContext, ToolDescriptor, ToolHandler } from '@melon-ai/core';
import { FILES_GRANT_KEY, files, folderCovers, folderScope } from '../../src/builtin/files/index.js';

const cx = (): ToolContext => ({
  taskId: 't' as never, callId: 'c' as never, trace: {} as never, signal: new AbortController().signal,
  putArtifact: async () => 'a' as never, readArtifact: async () => '', log: () => {},
});

async function tools(opts: Parameters<typeof files>[0] = {}): Promise<{ d: (id: string) => ToolDescriptor; run: (id: string, args: unknown) => Promise<string> }> {
  const [b] = await files(opts).list();
  return {
    d: (id) => b!.skill.tools.find((t) => t.id === id)!,
    run: async (id, args) => (await (b!.handlers.get(id) as ToolHandler)(args, cx())).summary,
  };
}

/** 一个最小的 PDF（一页，一行字）。xref 偏移按实际字节算。 */
function pdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    (() => { const s = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`; return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; })(),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function docx(text: string): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

async function xlsx(): Promise<Buffer> {
  const z = new JSZip();
  z.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="9月" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  z.file('xl/sharedStrings.xml', '<sst><si><t>部门</t></si><si><t>费用</t></si><si><r><t>产</t></r><r><t>品部</t></r></si></sst>');
  z.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1280.5</v></c></row></sheetData></worksheet>');
  return z.generateAsync({ type: 'nodebuffer' });
}

test('本地文件：列目录（隐藏文件不列、最新的在前）；按名字 / 类型 / 子文件夹找', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'files-'));
  try {
    writeFileSync(join(dir, 'old.txt'), 'x');
    utimesSync(join(dir, 'old.txt'), new Date('2026-01-01'), new Date('2026-01-01'));
    writeFileSync(join(dir, '合同-终版.pdf'), pdf('hello'));
    writeFileSync(join(dir, '.DS_Store'), 'x');
    mkdirSync(join(dir, '报表'));
    writeFileSync(join(dir, '报表', '9月合同.xlsx'), await xlsx());
    const t = await tools();
    const out = await t.run('files.list', { folder: dir });
    assert.match(out, /2 个文件、1 个文件夹/);
    assert.doesNotMatch(out, /DS_Store/);
    assert.ok(out.indexOf('old.txt') > out.indexOf('合同-终版.pdf'), '最新的在前');
    const found = await t.run('files.find', { folder: dir, name: '合同' });
    assert.match(found, /找到 2 个/);
    assert.match(found, /报表\/9月合同\.xlsx/);
    assert.match(await t.run('files.find', { folder: dir, ext: 'pdf' }), /找到 1 个[\s\S]*合同-终版\.pdf/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('本地文件：读文本（长的分段、offset 接着读）、PDF、Word、Excel；读不了的说清楚；不能越出文件夹', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'files-'));
  try {
    writeFileSync(join(dir, 'long.md'), 'a'.repeat(25) + 'b'.repeat(10));
    writeFileSync(join(dir, 'doc.pdf'), pdf('Quarterly report'));
    writeFileSync(join(dir, 'memo.docx'), await docx('会议纪要：下周上线'));
    writeFileSync(join(dir, 'cost.xlsx'), await xlsx());
    writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
    const t = await tools({ chunkChars: 25 });
    const first = await t.run('files.read', { folder: dir, file: 'long.md' });
    assert.match(first, /共 35 字/);
    assert.match(first, /还有 10 字没读。要接着读就用 offset=25/);
    assert.match(await t.run('files.read', { folder: dir, file: 'long.md', offset: 25 }), /bbbbbbbbbb$/);
    const big = await tools();
    assert.match(await big.run('files.read', { folder: dir, file: 'doc.pdf' }), /PDF，1 页[\s\S]*Quarterly report/);
    assert.match(await big.run('files.read', { folder: dir, file: 'memo.docx' }), /会议纪要：下周上线/);
    const sheet = await big.run('files.read', { folder: dir, file: 'cost.xlsx' });
    assert.match(sheet, /Excel，1 张表/);
    assert.match(sheet, /## 9月\n部门\t费用\n产品部\t\t1280\.5/, '富文本单元格拼起来；空单元格保持列对齐');
    // 读不了的、越界的：问用户之前就退回给模型
    const pre = t.d('files.read').precheck!;
    assert.match((await pre({ folder: dir, file: 'pic.png' }))!.message, /是图片，读不了文字/);
    assert.match((await pre({ folder: dir, file: 'nope.txt' }))!.message, /没有 .*nope\.txt 这个文件/);
    await assert.rejects(t.run('files.read', { folder: dir, file: '../../etc/hosts' }), /不在/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('本地文件：问之前先查 —— 文件夹写错给近似的；受保护的位置（宿主数据、密钥）直接退回', async () => {
  const root = mkdtempSync(join(tmpdir(), 'files-'));
  try {
    mkdirSync(join(root, 'Downloads'));
    mkdirSync(join(root, 'appdata'));
    const t = await tools({ denyRead: [join(root, 'appdata')] });
    const pre = t.d('files.list').precheck!;
    const miss = (await pre({ folder: join(root, 'Download') }))!;
    assert.match(miss.message, /没有 .*Download 这个文件夹/);
    assert.match(miss.hint!, /可能是 .*Downloads：用它再试一次/);
    assert.match((await pre({ folder: join(root, 'appdata') }))!.message, /受保护的位置/);
    assert.match((await pre({ folder: '~/.ssh' }))!.message, /受保护的位置/);
    assert.equal(await pre({ folder: join(root, 'Downloads') }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('本地文件：数据出境 —— 三个工具都是对外操作、输出不可信；「始终允许」按文件夹（含子文件夹），三个工具共用', async () => {
  const t = await tools();
  for (const id of ['files.list', 'files.find', 'files.read']) {
    const d = t.d(id);
    assert.equal(d.risk, 'external');
    assert.equal(d.untrustedOutput, true);
    assert.equal(d.grantBy!.key, FILES_GRANT_KEY);
  }
  const s = folderScope('/Users/me/Downloads/');
  assert.equal(s, 'folder=/Users/me/Downloads');
  assert.equal(folderCovers(s, 'folder=/Users/me/Downloads/报表'), true);
  assert.equal(folderCovers(s, 'folder=/Users/me/Downloads'), true);
  assert.equal(folderCovers(s, 'folder=/Users/me/Downloads2'), false, '名字前缀相同的别的文件夹不算');
  assert.equal(folderCovers(s, 'folder=/Users/me'), false);
});

test('附件：抽出文字和说明；图片、文件夹、受保护的位置给出原因', async () => {
  const { prepareAttachment } = await import('../../src/builtin/files/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'attach-'));
  try {
    writeFileSync(join(dir, '费用.xlsx'), await xlsx());
    writeFileSync(join(dir, 'a.png'), Buffer.from([0x89, 0x50]));
    mkdirSync(join(dir, 'secret'));
    writeFileSync(join(dir, 'secret', 'k.txt'), 'sk-1');
    const a = await prepareAttachment(join(dir, '费用.xlsx'));
    assert.equal(a.name, '费用.xlsx');
    assert.match(a.note, /Excel，1 张表/);
    assert.match(a.text, /产品部\t\t1280\.5/);
    await assert.rejects(prepareAttachment(join(dir, 'a.png')), /当前模型看不了图片/);
    await assert.rejects(prepareAttachment(dir), /是文件夹/);
    await assert.rejects(prepareAttachment(join(dir, 'secret', 'k.txt'), { denyRead: [join(dir, 'secret')] }), /受保护的位置/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('生成文件：写到输出目录（每个任务一个子目录），结果带上文件；CSV 加 BOM；文件名不能带路径、扩展名有限制', async () => {
  const { outputs } = await import('../../src/builtin/files/index.js');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'out-'));
  try {
    const [b] = await outputs({ dir }).list();
    const d = b!.skill.tools.find((t) => t.id === 'output.write')!;
    assert.equal(d.risk, 'write', '只写输出区：本地写入，不用每次问');
    const run = b!.handlers.get('output.write')!;
    const r = await run({ name: '../../九月汇总.csv', content: '部门,费用\n产品部,1280' }, cx());
    assert.equal(r.files![0]!.name, '九月汇总.csv');
    assert.equal(r.files![0]!.path, join(dir, 't', '九月汇总.csv'));
    assert.ok(readFileSync(r.files![0]!.path, 'utf8').startsWith('﻿部门,费用'));
    await assert.rejects(run({ name: 'x.exe', content: 'x' }, cx()), /文件名不行/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
