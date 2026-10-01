/**
 * 沙箱：跑不受信任的代码（用户装的技能脚本）时，限制它能读写哪里、能不能联网。
 *
 * 为什么在引擎：任何宿主跑用户装的脚本都需要它；「确认后执行」只管要不要跑，管不了跑起来之后做什么 ——
 * 脚本拿着用户的系统权限，能读到宿主存 key 的文件、能把东西发到网上。
 *
 * 规则（Claude Code 的沙箱也是这个思路）：
 * - 读：默认放行，敏感位置拦截（Python 第三方包、Homebrew 工具都在家目录和系统目录里，默认拦截会让多数脚本跑不起来）；
 * - 写：只能写给定的目录（这次任务的工作目录）；
 * - 联网：默认关，按技能打开。
 */
/**
 * 家目录下默认受保护的位置（相对家目录）：密钥、云账号凭据、钥匙串、浏览器资料、邮件、终端历史。
 * 沙箱里的脚本不能读，本地文件技能也不读。宿主再加上自己存 key 的目录。
 */
export const SENSITIVE_HOME_PATHS: readonly string[] = [
  '.ssh', '.aws', '.gnupg', '.config', '.netrc', '.docker', '.kube', '.npmrc', '.pypirc', '.git-credentials',
  '.azure', '.gcloud', '.zsh_history', '.bash_history',
  'Library/Keychains', 'Library/Cookies', 'Library/Mail', 'Library/Messages', 'Library/Safari',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
  'Library/Application Support/Microsoft Edge', 'Library/Application Support/BraveSoftware',
];

export interface SandboxPolicy {
  /** 可写的目录（含子目录）。 */
  readonly writable: readonly string[];
  /** 不许读的位置（目录或文件）。比 `writable` 优先级低：工作目录即使在拦截的目录里也能读写。 */
  readonly denyRead: readonly string[];
  readonly network: boolean;
}

/** 脚本被沙箱拦下了什么。宿主据此给用户看「想联网 / 想读某个文件」，并给出放行的入口。 */
export interface SandboxDenial {
  readonly kind: 'network' | 'read' | 'write';
  readonly path?: string;
}

export interface Sandbox {
  /** 实现的名字，如 `seatbelt`（macOS）。 */
  readonly kind: string;
  /** 把一条命令包进沙箱：返回实际要执行的命令和参数。 */
  wrap(file: string, args: readonly string[], policy: SandboxPolicy): { readonly file: string; readonly args: readonly string[] };
  /** 从脚本的输出判断是不是被沙箱拦下了（拦下时系统调用返回「Operation not permitted」）。不是返回 null。 */
  denial(output: { readonly stdout: string; readonly stderr: string }, policy: SandboxPolicy): SandboxDenial | null;
}
