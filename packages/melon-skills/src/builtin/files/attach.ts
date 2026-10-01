import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { extract, readableKind } from './extract.js';
import { canonical, isProtected, protectedPaths } from './paths.js';

/** 图片：现在接的模型都不能看图。 */
const IMAGE = /\.(png|jpe?g|gif|heic|webp|bmp|tiff?)$/i;

/**
 * 用户拖进对话的文件 → `agent.run` 的附件：名字、大小、说明、抽出的文字（与本地文件技能同一套解析）。
 * 读不了的（图片、旧版 Office、二进制、太大）抛错，错误信息直接给用户看。
 * 受保护的位置（密钥、钥匙串、宿主的数据目录）不读 —— 拖放的路径来自界面，主进程不能照单全收。
 */
export async function prepareAttachment(path: string, opts: { denyRead?: readonly string[] } = {}): Promise<{ name: string; size: number; note: string; text: string }> {
  const full = canonical(path);
  const name = basename(full);
  if (isProtected(full, protectedPaths(opts.denyRead ?? []))) throw new Error(`${name} 在受保护的位置，不能作为附件`);
  let st;
  try { st = statSync(full); } catch { throw new Error(`找不到 ${name}`); }
  if (st.isDirectory()) throw new Error(`${name} 是文件夹 —— 要看文件夹里的内容，直接在对话里说它的位置`);
  if (IMAGE.test(name)) throw new Error(`${name} 是图片，当前模型看不了图片`);
  const k = readableKind(full);
  if ('unreadable' in k) throw new Error(`${name} 是${k.unreadable}，读不了文字`);
  const got = await extract(full, k.kind);
  if (!got.text.trim()) throw new Error(`${name} 里没有可读的文字${k.kind === 'pdf' ? '（可能是扫描件）' : ''}`);
  return { name, size: st.size, note: got.note, text: got.text };
}
