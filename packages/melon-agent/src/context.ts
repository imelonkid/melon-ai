import type { Attachment, ContextBundle, Entry, EpisodeStore, Message, Task } from '@melon-ai/core';
import { BUILTIN_TOOLS } from '@melon-ai/core';
import { hostTimeZone } from '@melon-ai/engine';

/** 固定窗口：最近这么多条。长任务会撑爆 —— 由 @melon-ai/memory 的预算分配与压缩解决。 */
const MAX_ENTRIES = 40;

const roleOf = (kind: Entry['kind']): Message['role'] => (kind === 'assistant' ? 'assistant' : 'user');

/**
 * thought / tool_call / observation 都以 user 角色回灌 ——
 * 模型看到的是「这是刚刚发生的事实」，而不是它自己说过的话。
 * artifact 句柄必须写进文本，否则模型只看到摘要、不知道有全文可取（§10 第 41 条）。
 */
function render(e: Entry): string {
  if (e.kind === 'observation') {
    const handle = e.artifactRef ? `\n（完整内容句柄：${e.artifactRef}，可用 ${BUILTIN_TOOLS.ARTIFACT_READ} 取全文；摘要已够用就不必读）` : '';
    return `【工具返回】${e.text}${handle}`;
  }
  if (e.kind === 'tool_call') return `【调用工具】${e.text}`;
  return e.text;
}

/** 新给的附件带开头这么多字；全文按句柄取。 */
const ATTACH_HEAD = 3000;

/** 一轮最多带几张图（新给的优先，再是最近沿用的）：图片按张计费，追问时全带上太贵。 */
const MAX_IMAGES = 4;

/**
 * 图片附件 → 一条带图片的消息（句柄；发给模型前 agent 读出内容）。超出的只列名字。
 * 图片里也可能写着「指令」：和文字附件一样标成工具数据。
 */
function imageMessage(list: readonly Attachment[]): Message | null {
  const imgs = list.filter((a) => a.image);
  if (imgs.length === 0) return null;
  const chosen = [...imgs.filter((a) => a.fresh), ...imgs.filter((a) => !a.fresh).reverse()].slice(0, MAX_IMAGES);
  const left = imgs.filter((a) => !chosen.includes(a));
  const names = chosen.map((a) => `${a.name}${a.fresh ? '' : '（之前给过的）'}`).join('、');
  return {
    role: 'user', from: 'tool',
    content: `【图片】${names}${left.length ? `\n（更早的 ${left.length} 张图片没有带上：${left.map((a) => a.name).join('、')}。要看的话请用户再发一次）` : ''}`,
    images: chosen.map((a) => ({ ref: a.textRef, mime: a.image!.mime })),
  };
}

/** 附件进上下文的写法：句柄写在最前面（预算压缩截短时只保留开头，句柄不能丢）。 */
function renderAttachments(list: readonly Attachment[]): string {
  return list.filter((a) => !a.image).map((a) => {
    const head = `【附件】${a.name}（${a.note}，共 ${a.chars} 字；完整内容句柄：${a.textRef}，可用 ${BUILTIN_TOOLS.ARTIFACT_READ} 分段读）`;
    if (!a.fresh) return `${head}\n（之前给过的，需要时再读）`;
    const body = (a.head ?? '').slice(0, ATTACH_HEAD);
    return a.chars > body.length ? `${head}\n开头：\n${body}\n…（后面还有 ${a.chars - body.length} 字）` : `${head}\n${body}`;
  }).join('\n\n');
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 「2026-10-02 周五 16:00（Asia/Shanghai）」。模型要把「周五下午」落成具体日期，得知道今天是哪天。 */
export function nowLine(at: number, tz: string = hostTimeZone()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  return `${parts.year}-${parts.month}-${parts.day} 周${WEEKDAY[wd] ?? ''} ${parts.hour}:${parts.minute}（${tz}）`;
}

export interface BasicContextOptions {
  /** 放在任务目标之前、不压缩的消息，例如宿主的说明。 */
  readonly prelude?: (task: Task) => Promise<readonly Message[]> | readonly Message[];
  /**
   * 之前的对话（用户问、助手答），放在 prelude 之后、目标之前。超出上下文预算时引擎先把旧的摘要掉（最后两轮原样保留）——
   * 宿主可以多给几轮，不用自己算长度。
   */
  readonly history?: (task: Task) => Promise<readonly Message[]> | readonly Message[];
  /** 任务目标的写法。默认「任务目标：…」。 */
  readonly goal?: (task: Task) => string;
  readonly window?: number;
  /**
   * 当前时间。默认带上（`Date.now`，宿主时区）—— 没有它，「明天」「周五下午」模型只能猜。
   * 传 `false` 不带；测试可传固定时钟。
   */
  readonly now?: (() => number) | false;
  /** 时区。默认宿主时区。 */
  readonly timeZone?: string;
}

/**
 * 默认上下文：任务目标 + 本任务最近的步骤。
 *
 * ⚠️ 这是 `@melon-ai/memory` 就位前的默认实现：**没有预算分配、没有压缩、没有长期记忆检索**。
 * 宿主要在目标之前加点东西（对话历史、产品说明），用 `prelude`，不必整个重写。当前时间默认就带。
 */
export function basicContext(episodes: EpisodeStore, opts: BasicContextOptions = {}) {
  return async (task: Task): Promise<ContextBundle> => {
    const entries = (await episodes.readEntries(task.episodeId)).slice(-MAX_ENTRIES);
    const messages: Message[] = [
      ...(opts.prelude ? await opts.prelude(task) : []),
      ...(opts.history ? (await opts.history(task)).map((m) => ({ ...m, part: 'history' as const })) : []),
      // 附件：用户给的文件，但内容不是用户说的话（里面的邮箱、「指令」不算用户给的）—— 标成工具数据。
      // 放在用户这句话之前：问题留在最后、离回答最近（附件常常很长）
      ...(task.attachments?.some((a) => !a.image) ? [{ role: 'user' as const, from: 'tool' as const, part: 'result' as const, content: renderAttachments(task.attachments) }] : []),
      ...(task.attachments ? [imageMessage(task.attachments)].filter((m): m is Message => m !== null) : []),
      { role: 'user', content: opts.goal ? opts.goal(task) : `任务目标：${task.goal}` },
      // 放在目标之后：前面的对话历史每轮不变，能吃到 prompt cache；时间每轮都变
      ...(opts.now === false ? [] : [{
        role: 'user' as const, from: 'host' as const,
        content: `（现在是 ${nowLine((opts.now ?? Date.now)(), opts.timeZone)}。）`,
      }]),
      // 工具的调用与结果以 user 角色回灌，但不是用户说的 —— 标出来，规划器据此核对「收件人是不是用户给的」
      ...entries.map((e) => ({
        role: roleOf(e.kind), content: render(e),
        ...(e.kind === 'observation' || e.kind === 'tool_call' || e.kind === 'thought' ? { from: 'tool' as const } : {}),
        // 超出预算时：旧的工具结果先截短，较早的步骤再摘要
        part: e.kind === 'observation' ? 'result' as const : 'step' as const,
      })),
    ];
    return {
      messages,
      tools: [],
      slots: [],
      // 粗估：中文约 1 字 1 token、英文约 4 字符 1 token，取中间值
      totalTokens: messages.reduce((n, m) => n + Math.ceil(m.content.length / 2), 0),
      window: opts.window ?? 200_000,
      watermark: 0.7,
    };
  };
}
