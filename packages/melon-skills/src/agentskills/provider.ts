import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, join, resolve, sep } from 'node:path';
import type { Health, Sandbox, SandboxPolicy, SkillBundle, SkillProvider } from '@melon-ai/core';
import { ToolError, asSkillId } from '@melon-ai/core';
import { defineTool } from '../registry/define.js';
import type { Tool } from '../registry/define.js';
import { scanSkillDirs, unchangedSince } from './scan.js';
import type { AgentSkill, RejectedSkill, ScanLimits } from './scan.js';
import { detectSandbox, sensitivePaths } from './sandbox.js';

/**
 * Agent Skills 的接入（agentskills.io 规范的三级加载）：
 *
 * | 级别 | 规范 | 这里 |
 * |---|---|---|
 * | 1 清单 | 名字 + 描述一开始就给模型 | 写进 `skill.activate` 的说明里，名字参数限定为清单里的值 |
 * | 2 激活 | 相关时读入整份 SKILL.md 正文 | `skill.activate`：正文 + 技能目录 + 附带文件清单（只列不读），同一任务不重复注入 |
 * | 3 资源 | 按需读参考文档、跑脚本（只有输出进上下文）| `skill.read` 读技能目录内的文件；`skill.run` 跑技能自带的脚本 |
 *
 * 规划器和上下文装配都不用改 —— 技能对引擎来说就是三个工具。
 *
 * 安全：技能来自用户目录，注册前过 `scanSkillDirs` 的校验、净化、审查；
 * 跑脚本是对外操作（每次确认，「始终允许」按 技能+脚本 生效），输出一律不可信；
 * 跑之前核对脚本还是审查时的那一份。技能的 `allowed-tools` 不生效 —— 技能不能给自己预先授权。
 */

export interface AgentSkillsOptions {
  /** 技能目录，按优先级排（同名时前面的赢）。如 `['~/.myapp/skills', '~/.agents/skills']`。 */
  readonly dirs: readonly string[];
  /** 脚本的工作目录根；每个任务一个子目录。默认系统临时目录下的 melon-skills。 */
  readonly workDir?: string;
  /** 单个脚本的超时，默认 120s。 */
  readonly timeoutMs?: number;
  /** 解释器。默认 python3 / node / bash / zsh（从 PATH 找）。 */
  readonly interpreters?: Readonly<Partial<Record<'py' | 'js' | 'sh' | 'zsh', string>>>;
  readonly limits?: ScanLimits;
  /** 用户关掉的技能（按名字）。关掉的不进清单、不能激活；报告里标为已停用。 */
  readonly disabled?: readonly string[];
  /**
   * 沙箱。不给：自动用当前平台的（macOS 是 Seatbelt；没有时脚本照常跑，`report().sandbox` 为 null）。`false`：不用。
   * - 读：默认放行，`sensitivePaths()` 与 `denyRead`（宿主存 key 的目录）拦截；
   * - 写：只能写这次任务的工作目录；
   * - 联网：默认关，`network(技能名)` 为 true 的放行。
   */
  readonly sandbox?: false | {
    readonly runner?: Sandbox | null;
    readonly denyRead?: readonly string[];
    readonly network?: (skill: string) => boolean;
  };
}

export interface AgentSkillsReport {
  readonly loaded: readonly {
    readonly name: string; readonly description: string; readonly dir: string;
    readonly files: readonly string[]; readonly warnings: readonly string[]; readonly enabled: boolean;
  }[];
  readonly rejected: readonly RejectedSkill[];
  /** 脚本跑在什么沙箱里；null = 没有沙箱保护。 */
  readonly sandbox: { readonly kind: string } | null;
}

const EXT: Record<string, 'py' | 'js' | 'sh' | 'zsh'> = {
  '.py': 'py', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.sh': 'sh', '.bash': 'sh', '.zsh': 'zsh',
};
const DEFAULT_INTERP = { py: 'python3', js: 'node', sh: 'bash', zsh: 'zsh' } as const;
/** 从 Finder 启动的桌面应用 PATH 很短，常见的安装位置补上。 */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const READ_CHUNK = 12_000;
const OUTPUT_TAIL = 6_000;
const MAX_LISTED = 60;

const tail = (s: string, n: number): string => (s.length > n ? `…（前面省略 ${s.length - n} 字）\n${s.slice(-n)}` : s);

export class AgentSkillsProvider implements SkillProvider {
  readonly id = 'agent-skills';
  private loaded: readonly AgentSkill[] = [];
  private disabled: ReadonlySet<string>;
  private refused: readonly RejectedSkill[] = [];
  private readonly listeners = new Set<() => void>();
  /** 同一任务里已激活过的技能，不重复注入。 */
  private readonly activated = new Map<string, Set<string>>();

  /** 跑脚本用的沙箱；null = 没有。 */
  private readonly sandbox: Sandbox | null;

  constructor(private readonly opts: AgentSkillsOptions) {
    this.disabled = new Set(opts.disabled ?? []);
    this.sandbox = opts.sandbox === false ? null : opts.sandbox?.runner !== undefined ? opts.sandbox.runner : detectSandbox();
    this.reload();
  }

  /** 这次执行的沙箱规则：只写工作目录，敏感位置不许读，联网按技能。 */
  private policyFor(skill: string, work: string): SandboxPolicy {
    const o = this.opts.sandbox || undefined;
    return {
      writable: [work],
      denyRead: [...sensitivePaths(), ...(o?.denyRead ?? [])],
      network: o?.network?.(skill) ?? false,
    };
  }

  /** 用户在界面上开关某个技能。 */
  setDisabled(names: readonly string[]): void {
    this.disabled = new Set(names);
    for (const cb of this.listeners) cb();
  }

  /** 生效的技能：审查通过且没被用户关掉。 */
  private active(): readonly AgentSkill[] {
    return this.loaded.filter((s) => !this.disabled.has(s.name));
  }

  /** 重新扫描技能目录（用户装了新技能、改了文件之后）。改过的技能会重新审查。 */
  reload(): AgentSkillsReport {
    const r = scanSkillDirs(this.opts.dirs, this.opts.limits);
    this.loaded = r.skills;
    this.refused = r.rejected;
    for (const cb of this.listeners) cb();
    return this.report();
  }

  report(): AgentSkillsReport {
    return {
      loaded: this.loaded.map((s) => ({
        name: s.name, description: s.description, dir: s.dir, files: s.files, warnings: s.warnings,
        enabled: !this.disabled.has(s.name),
      })),
      rejected: this.refused,
      sandbox: this.sandbox ? { kind: this.sandbox.kind } : null,
    };
  }

  async list(): Promise<readonly SkillBundle[]> {
    if (this.active().length === 0) return []; // 没有技能就不注册工具 —— 空清单只会让模型困惑
    const tools = [this.activateTool(), this.readTool(), this.runTool()];
    return [{
      skill: {
        id: asSkillId('skill'),
        name: '技能',
        purpose: '任务和某个已安装技能的描述对得上时使用',
        keywords: [],
        tools: tools.map((t) => t.descriptor),
        source: { kind: 'extension', providerId: this.id, version: this.active().map((s) => s.hash.slice(0, 8)).join('.') },
      },
      handlers: new Map(tools.map((t) => [String(t.descriptor.id), t.handler])),
    }];
  }

  async health(): Promise<Health> {
    return { status: 'up' };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private find(name: string): AgentSkill {
    const s = this.active().find((x) => x.name === name);
    if (!s) throw new ToolError('INVALID_ARGS', `没有名为 ${name} 的技能`, { hint: `可用的技能：${this.active().map((x) => x.name).join('、')}` });
    return s;
  }

  /** 技能目录内的路径 → 绝对路径。越界（../、绝对路径、链接逃逸）一律拒绝。 */
  private inside(skill: AgentSkill, rel: string): string {
    const clean = String(rel ?? '').replace(/^\.\/+/, '');
    const full = resolve(skill.dir, clean);
    const deny = () => new ToolError('DENIED', `只能访问技能 ${skill.name} 自己目录里的文件`, { retriable: false });
    // 先按字面路径判越界，再看文件在不在 —— 否则越界路径会被报成「不存在」，等于在帮人探测文件系统
    if (full !== skill.dir && !full.startsWith(skill.dir + sep)) throw deny();
    let real: string;
    try { real = realpathSync(full); } catch { throw new ToolError('NOT_FOUND', `技能 ${skill.name} 里没有 ${clean}`, { hint: '用 skill.activate 返回的文件清单里的路径' }); }
    // 再按真实路径判一次：技能目录里的链接指到外面也不行
    if (real !== skill.dir && !real.startsWith(skill.dir + sep)) throw deny();
    return real;
  }

  private names(): string[] {
    return this.active().map((s) => s.name);
  }

  private activateTool(): Tool {
    const catalog = this.active()
      .map((s) => `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n</skill>`)
      .join('\n');
    return defineTool<{ name: string }>({
      id: 'skill.activate',
      description:
        '加载一个技能的完整操作说明。下面是已安装的技能；当任务和某个技能的描述对得上时，先用它加载说明，再照着说明做。'
        + '说明里提到的参考文件用 skill.read 读，提到的脚本用 skill.run 执行。\n'
        + `<available_skills>\n${catalog}\n</available_skills>`,
      input: { name: { type: 'string', enum: this.names(), description: '技能名' } },
      // 整份说明都要进上下文 —— 截断了模型只看到半份说明
      outputLimit: 32_000,
      run: ({ name }, cx) => {
        const s = this.find(name);
        const seen = this.activated.get(cx.taskId) ?? new Set<string>();
        if (seen.has(s.name)) return `技能 ${s.name} 的说明已经在上文加载过了，照着做即可，不用重复加载。`;
        seen.add(s.name);
        this.activated.set(cx.taskId, seen);
        if (this.activated.size > 1000) this.activated.delete(this.activated.keys().next().value as string);
        const resources = s.files.filter((f) => f !== 'SKILL.md');
        const listed = resources.slice(0, MAX_LISTED).map((f) => `<file>${f}</file>`).join('\n');
        return [
          `<skill_content name="${s.name}">`,
          s.body,
          '',
          `技能目录：${s.dir}`,
          '说明里的相对路径都相对于技能目录。读文件用 skill.read，执行脚本用 skill.run（传相对路径）。',
          ...(s.compatibility ? [`环境要求：${s.compatibility}`] : []),
          resources.length > 0
            ? `<skill_resources>\n${listed}${resources.length > MAX_LISTED ? `\n（还有 ${resources.length - MAX_LISTED} 个文件未列出）` : ''}\n</skill_resources>`
            : '',
          '</skill_content>',
        ].join('\n');
      },
    });
  }

  private readTool(): Tool {
    return defineTool<{ name: string; path: string; offset?: number }>({
      id: 'skill.read',
      description: '读取某个技能目录里的文件（参考文档、模板、数据）。只能读技能自己目录里的文件；很长的文件用 offset 分段读。',
      input: {
        name: { type: 'string', enum: this.names(), description: '技能名' },
        path: { type: 'string', description: '相对技能目录的路径，如 references/REFERENCE.md' },
        offset: { type: 'integer', optional: true, minimum: 0, description: '从第几个字符开始读，默认 0' },
      },
      // 参考文件没逐字审查过：读过的任务按不可信处理
      untrustedOutput: true,
      outputLimit: 16_000,
      run: ({ name, path, offset = 0 }) => {
        const s = this.find(name);
        const full = this.inside(s, path);
        if (statSync(full).isDirectory()) {
          return `${path} 是目录，里面有：${readdirSync(full).slice(0, MAX_LISTED).join('、')}`;
        }
        const buf = readFileSync(full);
        if (buf.subarray(0, 8000).includes(0)) {
          return `${path} 是二进制文件（${buf.length} 字节），不能作为文本读取。需要处理它的话用技能里的脚本。`;
        }
        const text = buf.toString('utf8');
        const part = text.slice(offset, offset + READ_CHUNK);
        const rest = text.length - (offset + part.length);
        return rest > 0 ? `${part}\n…（还有 ${rest} 字，用 offset=${offset + part.length} 接着读）` : part;
      },
    });
  }

  private runTool(): Tool {
    return defineTool<{ name: string; script: string; args?: string[] }>({
      id: 'skill.run',
      description:
        '执行某个技能自带的脚本（.py / .js / .sh 等），返回脚本的输出。只能执行技能目录里的脚本；'
        + '参数按顺序放进 args。每次执行都会先征得用户同意。脚本在一个临时工作目录里运行，产生的文件会列在结果里。'
        + '脚本跑在沙箱里：只能写工作目录（输出文件用相对路径），受保护的位置不能读，联网要用户给这个技能打开。',
      input: {
        name: { type: 'string', enum: this.names(), description: '技能名' },
        script: { type: 'string', description: '相对技能目录的脚本路径，如 scripts/extract.py' },
        args: { type: 'string[]', optional: true, description: '传给脚本的参数' },
      },
      // 跑的是用户装的代码：对外操作，每次确认；「始终允许」只放行同一个技能的同一个脚本
      risk: 'external',
      scope: ['name', 'script'],
      // 通用执行器：没有固定的说法（「跑一下」对应哪个技能由模型判断），执行前每次都要确认
      triggers: [],
      untrustedOutput: true,
      outputLimit: 8_000,
      run: async ({ name, script, args = [] }, cx) => {
        const s = this.find(name);
        const full = this.inside(s, script);
        const rel = full.slice(s.dir.length + 1).split(sep).join('/');
        if (!unchangedSince(s, rel)) {
          throw new ToolError('DENIED', `脚本 ${rel} 在审查之后被改动过，不能直接执行`, {
            retriable: false, hint: '告诉用户技能文件有改动，需要重新加载技能（重新审查）后再试',
          });
        }
        const kind = EXT[extname(full).toLowerCase()];
        const shebang = readFileSync(full).subarray(0, 2).toString() === '#!';
        if (!kind && !shebang) {
          throw new ToolError('INVALID_ARGS', `不认识的脚本类型：${rel}`, { hint: '只能执行 .py / .js / .sh 或带 #! 的脚本' });
        }
        const interp = kind ? (this.opts.interpreters?.[kind] ?? DEFAULT_INTERP[kind]) : null;
        const work = join(this.opts.workDir ?? join(tmpdir(), 'melon-skills'), String(cx.taskId));
        mkdirSync(work, { recursive: true });
        const before = new Set(readdirSync(work));
        const argv = (args ?? []).map(String);

        // 沙箱：解释器连同脚本一起包进去
        const policy = this.policyFor(s.name, work);
        const cmd = this.sandbox
          ? this.sandbox.wrap(interp ?? full, interp ? [full, ...argv] : argv, policy)
          : { file: interp ?? full, args: interp ? [full, ...argv] : argv };
        const out = await new Promise<{ code: number | null; stdout: string; stderr: string; err?: ExecFileException }>((done) => {
          const child = execFile(cmd.file, [...cmd.args], {
            cwd: work,
            timeout: this.opts.timeoutMs ?? 120_000,
            maxBuffer: 4 * 1024 * 1024,
            signal: cx.signal,
            // 只传必要的环境变量 —— 不把宿主进程里的 key 带给用户装的脚本
            env: {
              PATH: [...new Set([...(process.env['PATH'] ?? '').split(delimiter), ...EXTRA_PATH])].filter(Boolean).join(delimiter),
              HOME: process.env['HOME'] ?? '',
              LANG: process.env['LANG'] ?? 'en_US.UTF-8',
              TMPDIR: work,
              SKILL_DIR: s.dir,
              CLAUDE_SKILL_DIR: s.dir,
              PYTHONIOENCODING: 'utf-8',
            },
          }, (err, stdout, stderr) => done({
            code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
            stdout: String(stdout), stderr: String(stderr),
            ...(err ? { err } : {}),
          }));
          child.stdin?.end();
        });

        if (out.err && (out.err.code === 'ENOENT' || (out.err as { errno?: number }).errno === -2) && out.code === null) {
          throw new ToolError('FATAL', `找不到解释器 ${interp}`, { retriable: false, hint: `告诉用户需要先安装 ${interp}` });
        }
        const made = readdirSync(work).filter((f) => !before.has(f));
        const report = [
          out.err && (out.err as { killed?: boolean }).killed ? '（超时或被取消，已终止）' : '',
          out.stdout.trim() ? `输出：\n${tail(out.stdout.trim(), OUTPUT_TAIL)}` : '（没有输出）',
          out.stderr.trim() ? `错误输出：\n${tail(out.stderr.trim(), 2000)}` : '',
          made.length > 0 ? `生成的文件（在 ${work}）：${made.join('、')}` : '',
        ].filter(Boolean).join('\n');
        if (out.code !== 0) {
          // 被沙箱拦下：说清楚拦了什么，带上结构化的信息让宿主给用户放行的入口；不让模型换办法绕过
          const denied = this.sandbox?.denial(out, policy);
          if (denied) {
            const what = denied.kind === 'network' ? `想联网，被沙箱拦下了（技能 ${s.name} 没有联网权限）`
              : denied.kind === 'read' ? `想读 ${denied.path}，这是受保护的位置，被沙箱拦下了`
              : `想写 ${denied.path}，沙箱只允许写这次任务的工作目录`;
            const hint = denied.kind === 'network' ? '告诉用户：这个技能的脚本需要联网，可以在技能设置里允许它联网后再试。不要换别的办法绕过'
              : denied.kind === 'read' ? '告诉用户这个位置受保护、脚本不能读；需要的话请用户把文件复制到别的位置。不要换别的办法绕过'
              : '让脚本把文件写到当前工作目录（用相对路径）再试；脚本不支持就告诉用户';
            throw new ToolError('DENIED', `脚本 ${rel} ${what}\n${report}`, { retriable: false, hint, sandbox: denied });
          }
          throw new ToolError('UPSTREAM', `脚本 ${rel} 执行失败（退出码 ${out.code ?? '无'}）\n${report}`, { retriable: false });
        }
        // 生成的文件：宿主在对话里显示文件卡片（打开 / 另存为）
        const files = made.flatMap((name) => {
          try { const st = statSync(join(work, name)); return st.isFile() ? [{ name, path: join(work, name), size: st.size }] : []; } catch { return []; }
        });
        return files.length ? { summary: report, files } : report;
      },
    });
  }
}

/** 加载 Agent Skills。宿主决定扫哪些目录。 */
export function agentSkills(opts: AgentSkillsOptions): AgentSkillsProvider {
  return new AgentSkillsProvider(opts);
}

