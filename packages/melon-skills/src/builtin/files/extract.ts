import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * 从文件里取出给模型看的文字：纯文本照读；PDF、Word（.docx）、Excel（.xlsx）抽文字。
 * 图片、旧版 Office（.doc / .xls / .ppt）、压缩包等读不了文字的，明确说读不了 —— 不把二进制当文本塞给模型。
 */

export type FileKind = 'text' | 'pdf' | 'docx' | 'xlsx';
export interface Extracted {
  readonly kind: FileKind;
  readonly text: string;
  /** 给人看的附加说明：「PDF，12 页」「Excel，3 张表」。 */
  readonly note: string;
}

/** 太大的不读：抽文字要整个读进内存。 */
export const MAX_BYTES = 50 * 1024 * 1024;
/** Excel 每张表最多取多少行。 */
const MAX_ROWS = 2000;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.rb', '.php', '.c', '.h', '.cpp', '.cs',
  '.swift', '.kt', '.sh', '.zsh', '.sql', '.ini', '.toml', '.conf', '.cfg', '.env.example', '.srt', '.vtt', '.rtf',
]);
const UNREADABLE: Record<string, string> = {
  '.doc': '旧版 Word（.doc）', '.xls': '旧版 Excel（.xls）', '.ppt': 'PowerPoint', '.pptx': 'PowerPoint',
  '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.gif': '图片', '.heic': '图片', '.webp': '图片',
  '.zip': '压缩包', '.rar': '压缩包', '.7z': '压缩包', '.dmg': '安装包', '.pkg': '安装包', '.app': '应用',
  '.mp3': '音频', '.m4a': '音频', '.wav': '音频', '.mp4': '视频', '.mov': '视频',
};

/** 这个文件能不能读文字；读不了时给出原因（「图片」「旧版 Word（.doc）」）。 */
export function readableKind(path: string): { kind: FileKind } | { unreadable: string } {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return { kind: 'pdf' };
  if (ext === '.docx') return { kind: 'docx' };
  if (ext === '.xlsx') return { kind: 'xlsx' };
  if (TEXT_EXT.has(ext)) return { kind: 'text' };
  if (UNREADABLE[ext]) return { unreadable: UNREADABLE[ext]! };
  // 没有扩展名或不认识的：看开头有没有 0 字节，有就是二进制
  try {
    const head = readFileSync(path).subarray(0, 4096);
    return head.includes(0) ? { unreadable: '二进制文件' } : { kind: 'text' };
  } catch { return { unreadable: '读不了' }; }
}

export async function extract(path: string, kind: FileKind): Promise<Extracted> {
  const size = statSync(path).size;
  if (size > MAX_BYTES) throw new Error(`文件太大（${Math.round(size / 1024 / 1024)} MB），超过 ${MAX_BYTES / 1024 / 1024} MB 不读`);
  const buf = readFileSync(path);
  if (kind === 'text') return { kind, text: buf.toString('utf8'), note: '文本' };
  if (kind === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const body = String(text).trim();
    return { kind, text: body, note: body ? `PDF，${totalPages} 页` : `PDF，${totalPages} 页，没有可抽取的文字（可能是扫描件）` };
  }
  if (kind === 'docx') {
    const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
    const r = await mammoth.extractRawText({ buffer: buf });
    return { kind, text: r.value.trim(), note: 'Word 文档' };
  }
  return xlsxText(buf);
}

/** 解出 XML 里的转义字符。 */
const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
/** 一段 XML 里所有 <t> 的文字连起来（富文本单元格会拆成几段）。 */
const texts = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join('');

/** Excel（.xlsx 是 zip 包里的 XML）：每张表一节，每行用制表符分隔。 */
async function xlsxText(buf: Buffer): Promise<Extracted> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const read = async (name: string): Promise<string> => (await zip.file(name)?.async('string')) ?? '';
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)].map((m) => ({ name: unescape(m[1]!), file: target.get(m[2]!) ?? '' }));
  const parts: string[] = [];
  for (const sh of sheets) {
    const path = sh.file.startsWith('/') ? sh.file.slice(1) : `xl/${sh.file.replace(/^\.\//, '')}`;
    const xml = await read(path);
    const rows: string[] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) { rows.push(`…（还有更多行，只取了前 ${MAX_ROWS} 行）`); break; }
      const cells: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const col = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        // 补上空单元格，保持列对齐
        if (col) { const idx = [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1; while (cells.length < idx) cells.push(''); }
        const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        cells.push(t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? texts(body) : unescape(v ?? ''));
      }
      if (cells.some((x) => x !== '')) rows.push(cells.join('\t'));
    }
    parts.push(`## ${sh.name}\n${rows.join('\n')}`);
  }
  return { kind: 'xlsx', text: parts.join('\n\n'), note: `Excel，${sheets.length} 张表` };
}
