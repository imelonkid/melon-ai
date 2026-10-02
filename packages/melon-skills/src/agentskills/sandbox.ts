import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox, SandboxDenial, SandboxPolicy } from '@melon-ai/core';
import { SENSITIVE_HOME_PATHS } from '@melon-ai/core';

/**
 * 默认不许脚本读的位置（家目录下）：密钥、云账号凭据、钥匙串、浏览器资料、邮件、终端历史。
 * 宿主再加上自己存 key 的目录（`AgentSkillsOptions.sandbox.denyRead`）。
 */
export function sensitivePaths(home: string = homedir()): readonly string[] {
  return SENSITIVE_HOME_PATHS.map((p) => join(home, p));
}

/** Seatbelt 按真实路径匹配（/var 是 /private/var 的链接）：给出两种写法。 */
function forms(p: string): string[] {
  let real = p;
  try { real = realpathSync(p); } catch { /* 还不存在的位置按原样 */ }
  return [...new Set([p, real])];
}

/** `p` 在 `dir` 里面（两边都按真实路径比）。 */
function isUnder(p: string, dir: string): boolean {
  const ps = forms(p);
  return forms(dir).some((d) => ps.some((x) => x.startsWith(`${d}/`)));
}

const quote = (p: string): string => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * 沙箱规则（Seatbelt 的 SBPL）。后面的规则优先：先拦敏感位置，再放行工作目录 ——
 * 工作目录即使在拦截的目录里（宿主把它放在自己的数据目录下）也能读写；
 * 反过来，可写的范围包住了敏感位置（家目录可写、~/.ssh 不行）时，再拦一次。
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const sub = (paths: readonly string[]) => paths.flatMap(forms).map((p) => `(subpath ${quote(p)})`).join(' ');
  const lines = [
    '(version 1)',
    '(allow default)',
    // 写：只能写工作目录和几个设备文件
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
  ];
  if (policy.denyRead.length) lines.push(`(deny file-read* ${sub(policy.denyRead)})`);
  if (policy.writable.length) lines.push(`(allow file-read* file-write* ${sub(policy.writable)})`);
  // 可写的范围很大（MCP 服务器可写家目录）时，里面的受保护位置要再拦一次 —— 否则上一条的放行把它们也放了；
  // 受保护位置里面又有可写目录（工作目录在宿主数据目录里）的，最后再放行那个可写目录
  const inner = policy.denyRead.filter((d) => policy.writable.some((w) => d !== w && isUnder(d, w)));
  if (inner.length) {
    lines.push(`(deny file-read* file-write* ${sub(inner)})`);
    const reopen = policy.writable.filter((w) => inner.some((d) => isUnder(w, d)));
    if (reopen.length) lines.push(`(allow file-read* file-write* ${sub(reopen)})`);
  }
  // 联网：拦所有 IP 连接（含本机）；本机的 unix socket（域名解析走它）照常
  if (!policy.network) lines.push('(deny network-outbound (remote ip))', '(deny network-bind (local ip))');
  return lines.join('\n');
}

const NOT_PERMITTED = /operation not permitted|EPERM|Errno 1\]/i;
const NETWORK_HINT = /connect|connection|socket|urlopen|getaddrinfo|HTTP|fetch failed|Could not resolve|network/i;
/** 各语言报「没权限」时带的路径：Python 的 'path'、Node 的 open '/path'、shell 的 /path: Operation not permitted。 */
const PATH_PATTERNS = [
  /Operation not permitted: '([^']+)'/i,
  /EPERM: operation not permitted, \w+ '([^']+)'/i,
  /(\/[^\s:'"]+): Operation not permitted/i,
  /Operation not permitted[^\n]*?['"](\/[^'"]+)['"]/i,
];

/** 被拦下的位置在不在某个目录（含真实路径的写法）里。 */
const under = (path: string, dirs: readonly string[]): boolean =>
  dirs.flatMap(forms).some((d) => path === d || path.startsWith(`${d}/`));

/** 从脚本的输出判断被拦下了什么。 */
export function seatbeltDenial(output: { readonly stdout: string; readonly stderr: string }, policy: SandboxPolicy): SandboxDenial | null {
  const text = `${output.stderr}\n${output.stdout}`;
  if (!NOT_PERMITTED.test(text)) return null;
  for (const re of PATH_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return { kind: under(m[1], policy.denyRead) && !under(m[1], policy.writable) ? 'read' : 'write', path: m[1] };
  }
  if (!policy.network && NETWORK_HINT.test(text)) return { kind: 'network' };
  return null;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** macOS 自带的 Seatbelt（`sandbox-exec`）。Chrome、Claude Code 也用它。 */
export function seatbelt(): Sandbox {
  return {
    kind: 'seatbelt',
    wrap: (file, args, policy) => ({ file: SANDBOX_EXEC, args: ['-p', seatbeltProfile(policy), file, ...args] }),
    denial: seatbeltDenial,
  };
}

/** 当前平台能用的沙箱；没有时为 null（脚本照常跑，宿主应提示「无沙箱保护」）。以后加 Linux 的 bubblewrap。 */
export function detectSandbox(): Sandbox | null {
  if (process.platform === 'darwin' && existsSync(SANDBOX_EXEC)) return seatbelt();
  return null;
}
