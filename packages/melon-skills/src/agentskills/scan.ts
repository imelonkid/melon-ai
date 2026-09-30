import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { findInjection, sanitizeText } from '../registry/review.js';
import type { ReviewIssue } from '../registry/review.js';
import { asString, parseSkillMd } from './frontmatter.js';

/**
 * 发现与审查 Agent Skills（agentskills.io 规范）。
 *
 * 一个技能是一个目录，里面至少有 `SKILL.md`（frontmatter 写 name / description，正文是给 Agent 的操作说明），
 * 可带 `scripts/`、`references/`、`assets/`。这里做三件事：
 *
 * 1. **校验**：按规范检查 name / description；文件数、大小有上限；指向目录外的符号链接直接拒绝
 * 2. **净化**：名字、描述、正文做 Unicode 规范化，去掉控制字符与不可见字符
 * 3. **审查**：说明文字里的提示注入写法、脚本里的高危操作 —— 高危的拒绝，中危的提醒
 *
 * 审查通过后记下全部文件的内容哈希。执行脚本前会再核对一次：审查后被改过的技能不能直接跑。
 */

export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  /** SKILL.md 正文（已净化，`${CLAUDE_SKILL_DIR}` 已替换成技能目录）。 */
  readonly body: string;
  /** 技能目录的绝对路径（真实路径）。 */
  readonly dir: string;
  /** SKILL.md 的绝对路径。 */
  readonly location: string;
  /** 目录下的文件（相对路径，已排序）。 */
  readonly files: readonly string[];
  /** 审查时全部文件内容的哈希。 */
  readonly hash: string;
  /** 每个文件审查时的哈希 —— 执行脚本前逐个核对。 */
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly license?: string;
  readonly compatibility?: string;
  readonly warnings: readonly string[];
}

export interface RejectedSkill {
  readonly dir: string;
  readonly name?: string;
  readonly reasons: readonly string[];
}

export interface ScanResult {
  readonly skills: readonly AgentSkill[];
  readonly rejected: readonly RejectedSkill[];
}

export interface ScanLimits {
  /** 每个技能最多多少个文件。默认 500。 */
  readonly maxFiles?: number;
  /** 每个技能的总大小。默认 20MB。 */
  readonly maxBytes?: number;
  /** SKILL.md 的大小。默认 256KB。 */
  readonly maxSkillMd?: number;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.DS_Store']);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BODY_MAX = 100_000;

/** 当作脚本来审查的文件。 */
const SCRIPT_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|ps1)$/i;

/**
 * 脚本里的高危写法：命中即拒绝整个技能。
 * 这不是沙箱，是一道筛子 —— 挡住明显恶意或明显危险的，执行时还有每次确认兜底。
 */
const SCRIPT_DANGER: readonly [RegExp, string][] = [
  [/\brm\s+-[a-z]*r[a-z]*\s+(-[a-z]+\s+)*("|')?(\/|~|\$HOME|\$\{HOME\})("|')?(\s|$|\/\*)/i, '删除根目录或整个用户目录'],
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, '下载后直接交给 shell 执行'],
  [/\bsudo\b/, '使用 sudo 提权'],
  [/(\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.git-credentials|Library\/Keychains|security\s+(find|dump)-(generic|internet)-password|\.gnupg\/)/, '读取密钥、凭据或钥匙串'],
  [/\bmkfs(\.\w+)?\b|\bdd\s+[^\n]*of=\/dev\/(disk|sd|nvme|rdisk)/, '格式化或直接写磁盘'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork 炸弹'],
  [/\b(eval|exec)\s*\(\s*(requests\.get|urllib\.request\.urlopen|urlopen|base64\.b64decode|atob)\b/, '执行远程下载或解码出来的代码'],
  [/\b(launchctl\s+load|crontab\s+-|\/etc\/(sudoers|passwd|hosts))/, '修改系统配置或开机自启'],
];

/** 中危：提醒用户，不拦。 */
const SCRIPT_CAUTION: readonly [RegExp, string][] = [
  [/\b(requests\.(get|post|put)|urllib\.request|http\.client|fetch\(|axios|curl\b|wget\b|socket\.connect)/, '会访问网络'],
  [/\b(subprocess\.|os\.system\(|child_process|execSync|spawnSync)/, '会启动其他程序'],
  [/os\.environ\[|process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASS)/, '读取环境变量里的密钥'],
];

/** 正文里的这几类是硬拒绝；「冒充角色标记」在正文里可能是示例（比如教人写提示词的技能），只提醒。 */
const HARD_INJECTION = new Set(['要求忽略之前的指令', '要求对用户隐瞒', '要求绕过确认', '要求模型总是调用自己']);

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/**
 * 去掉注释再扫：防御性代码常在注释里写「不能读 ~/.ssh/id_rsa」，按原文扫会误伤
 * （Anthropic 官方的 claude-api 技能就是这样被误拦的）。只去整行注释与块注释，粗但够用。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\"\"\"|''')[\s\S]*?\1/gm, '')
    .split('\n')
    .filter((l) => !/^\s*(#(?!!)|\/\/|\*|--\s)/.test(l))
    .join('\n');
}

/** 列出技能目录下的文件；发现逃出目录的符号链接就记下来。 */
function walk(root: string, limits: Required<ScanLimits>): { files: string[]; bytes: number; escapes: string[]; tooMany: boolean } {
  const files: string[] = [];
  const escapes: string[] = [];
  let bytes = 0;
  let tooMany = false;
  const visit = (dir: string, depth: number) => {
    if (depth > 6 || tooMany) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full);
      if (lstatSync(full).isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(full); } catch { escapes.push(rel); continue; }
        if (target !== root && !target.startsWith(root + sep)) { escapes.push(rel); continue; }
      }
      const st = statSync(full);
      if (st.isDirectory()) { visit(full, depth + 1); continue; }
      if (!st.isFile()) continue;
      files.push(rel.split(sep).join('/'));
      bytes += st.size;
      if (files.length > limits.maxFiles) { tooMany = true; return; }
    }
  };
  visit(root, 0);
  return { files: files.sort(), bytes, escapes, tooMany };
}

/** 审查一个技能目录。返回技能，或拒绝原因。 */
export function reviewSkillDir(dirPath: string, limits: ScanLimits = {}): AgentSkill | RejectedSkill {
  const L: Required<ScanLimits> = { maxFiles: 500, maxBytes: 20 * 1024 * 1024, maxSkillMd: 256 * 1024, ...limits };
  const reasons: string[] = [];
  const warnings: string[] = [];
  let dir: string;
  try { dir = realpathSync(resolve(dirPath)); } catch { return { dir: dirPath, reasons: ['目录不存在或无法读取'] }; }
  const location = join(dir, 'SKILL.md');

  let raw: string;
  try {
    if (statSync(location).size > L.maxSkillMd) return { dir, reasons: [`SKILL.md 超过 ${Math.round(L.maxSkillMd / 1024)}KB`] };
    raw = readFileSync(location, 'utf8');
  } catch {
    return { dir, reasons: ['没有 SKILL.md'] };
  }
  const parsed = parseSkillMd(raw);
  if (!parsed) return { dir, reasons: ['SKILL.md 开头没有可解析的 frontmatter（--- 包起来的 name / description）'] };

  // ── 校验（从宽：名字问题只提醒，描述缺失才跳过）──
  const dirName = dir.split(sep).pop() ?? '';
  const rawName = asString(parsed.fields['name'])?.trim() || dirName;
  const name = sanitizeText(rawName, 64).toLowerCase();
  if (!NAME.test(name)) warnings.push(`名字「${rawName}」不符合规范（小写字母、数字、连字符）`);
  if (name !== dirName) warnings.push(`名字「${name}」与目录名「${dirName}」不一致`);
  if (/anthropic|claude/.test(name)) warnings.push('名字里含有保留词 anthropic / claude');
  const rawDesc = asString(parsed.fields['description']) ?? '';
  const description = sanitizeText(rawDesc, 1024, 'NFC');
  if (!description) reasons.push('缺少 description —— 没有它 Agent 无从判断什么时候用这个技能');
  if (rawDesc.length > 1024) warnings.push('description 超过 1024 字，已截断');
  if (/<[a-z/][^>]*>/i.test(description.normalize('NFKC'))) reasons.push('description 里不能有 XML 标签');
  if (parsed.fields['allowed-tools'] !== undefined) {
    warnings.push('allowed-tools 不生效：技能不能给自己预先授权，执行脚本仍要逐次确认');
  }

  // ── 文件 ──
  const tree = walk(dir, L);
  if (tree.escapes.length > 0) reasons.push(`有指向技能目录以外的链接：${tree.escapes.slice(0, 3).join('、')}`);
  if (tree.tooMany) reasons.push(`文件超过 ${L.maxFiles} 个`);
  if (tree.bytes > L.maxBytes) reasons.push(`总大小超过 ${Math.round(L.maxBytes / 1024 / 1024)}MB`);

  // ── 净化 + 审查说明文字 ──
  const body = sanitizeText(parsed.body, BODY_MAX, 'NFC').replace(/\$\{CLAUDE_SKILL_DIR\}/g, dir);
  if (parsed.body.length > BODY_MAX) warnings.push('SKILL.md 正文过长，已截断');
  for (const why of findInjection(description.normalize('NFKC'))) reasons.push(`description 里有提示注入的写法：${why}`);
  for (const why of findInjection(body.normalize('NFKC'))) {
    if (HARD_INJECTION.has(why)) reasons.push(`SKILL.md 正文里有提示注入的写法：${why}`);
    else warnings.push(`SKILL.md 正文里出现「${why}」，如果只是示例可以忽略`);
  }

  // ── 审查脚本 + 记哈希 ──
  const fileHashes: Record<string, string> = {};
  const all = createHash('sha256');
  if (!tree.tooMany) {
    for (const rel of tree.files) {
      const buf = readFileSync(join(dir, rel));
      const h = sha(buf);
      fileHashes[rel] = h;
      all.update(`${rel}\0${h}\n`);
      const isScript = SCRIPT_EXT.test(rel) || buf.subarray(0, 2).toString() === '#!';
      if (!isScript || buf.length > 1024 * 1024) continue;
      const src = codeOnly(buf.toString('utf8'));
      for (const [re, why] of SCRIPT_DANGER) if (re.test(src)) reasons.push(`脚本 ${rel}：${why}`);
      for (const [re, why] of SCRIPT_CAUTION) if (re.test(src)) warnings.push(`脚本 ${rel}：${why}`);
    }
  }

  if (reasons.length > 0) return { dir, name, reasons: [...new Set(reasons)] };
  const license = asString(parsed.fields['license']);
  const compatibility = asString(parsed.fields['compatibility']);
  return {
    name, description, body, dir, location, files: tree.files, fileHashes,
    hash: all.digest('hex'),
    ...(license ? { license: sanitizeText(license, 200) } : {}),
    ...(compatibility ? { compatibility: sanitizeText(compatibility, 500) } : {}),
    warnings: [...new Set(warnings)],
  };
}

export const isRejected = (r: AgentSkill | RejectedSkill): r is RejectedSkill => 'reasons' in r;

/**
 * 扫描若干个技能目录（如 `~/.jolly/skills`、`~/.agents/skills`）。
 * 每个目录下的子目录里有 `SKILL.md` 的就是一个技能。
 * **同名时先出现的目录优先**，后面的记为被拒（原因：重名）。
 */
export function scanSkillDirs(roots: readonly string[], limits: ScanLimits = {}): ScanResult {
  const skills: AgentSkill[] = [];
  const rejected: RejectedSkill[] = [];
  const seen = new Map<string, string>();
  for (const root of roots) {
    let entries: string[];
    try { entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { continue; }
    for (const name of entries.sort()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const dir = join(root, name);
      try { if (!statSync(join(dir, 'SKILL.md')).isFile()) continue; } catch { continue; }
      const r = reviewSkillDir(dir, limits);
      if (isRejected(r)) { rejected.push(r); continue; }
      const first = seen.get(r.name);
      if (first) { rejected.push({ dir: r.dir, name: r.name, reasons: [`与 ${first} 里的技能重名，以先找到的为准`] }); continue; }
      seen.set(r.name, r.dir);
      skills.push(r);
    }
  }
  return { skills, rejected };
}

/** 执行前核对：文件还是审查时的那一份吗？ */
export function unchangedSince(skill: AgentSkill, rel: string): boolean {
  const expected = skill.fileHashes[rel];
  if (!expected) return false;
  try { return sha(readFileSync(join(skill.dir, rel))) === expected; } catch { return false; }
}

export type { ReviewIssue };
