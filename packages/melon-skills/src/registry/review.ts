import type { JSONSchema, RiskClass, ToolDescriptor } from '@melon-ai/core';
import { RISK_ORDER } from '@melon-ai/core';

/**
 * 注册前的把关：**校验 → 净化 → 审查**。
 *
 * 工具的说明文字会原样进模型的上下文，等于一段由第三方写进系统提示的文字。
 * 所以任何来源的工具（内置、宿主、用户装的技能）在注册前都要过这一关，
 * 不合格的不注册，原因逐条给出 —— 宿主拿去展示给用户。
 *
 * 这里只看**文字与声明**；技能自带脚本的审查在 agentskills/ 里，同样的原则。
 */

export interface ReviewIssue {
  /** error：拒绝注册；warn：照常注册，但要让用户知道。 */
  readonly level: 'error' | 'warn';
  readonly message: string;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** 零宽字符与文字方向覆盖：肉眼看不见，却能把一段指令藏进正常文字里。 */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * 净化：Unicode 规范化、去掉控制字符与不可见字符、截断。
 * 名字、说明用 NFKC（把全角、兼容字符折成标准形，防止拿形似字符绕过审查）；
 * 大段正文用 NFC，保留原样的代码与标点 —— 审查另用 NFKC 形式去查。
 */
export function sanitizeText(s: string, max: number, form: 'NFKC' | 'NFC' = 'NFKC'): string {
  const clean = String(s ?? '').normalize(form).replace(CONTROL, '').replace(INVISIBLE, '').trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** 原文里藏了不可见字符，值得告诉用户。用不带 g 的副本 —— 带 g 的正则 test() 有状态。 */
const INVISIBLE_ONE = new RegExp(INVISIBLE.source);
const CONTROL_ONE = new RegExp(CONTROL.source);
const hadHidden = (s: string): boolean => INVISIBLE_ONE.test(s) || CONTROL_ONE.test(s.replace(/[\n\t\r]/g, ''));

/**
 * 提示注入的典型写法。命中就拒绝 —— 正常的工具说明、技能说明不会这样写。
 * 宁可误伤一个措辞奇怪的说明，也不放过一个想改写 Agent 行为的。
 */
const INJECTION: readonly [RegExp, string][] = [
  [/忽略(掉)?(之前|以上|前面|先前|上面|所有)(的)?(所有)?(指令|指示|规则|提示|要求)/, '要求忽略之前的指令'],
  [/\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?)/i, '要求忽略之前的指令'],
  [/<\/?\s*(system|assistant|developer)\s*>/i, '冒充系统 / 助手消息的标记'],
  [/^\s*(system|assistant|developer)\s*[:：]/im, '冒充系统 / 助手消息的标记'],
  [/\[\/?(INST|SYS)\]|<\|(im_start|im_end|system)\|>/i, '冒充模型的特殊标记'],
  [/(不要|别|勿)(告诉|通知|让)用户/, '要求对用户隐瞒'],
  [/\b(do\s+not|don't|never)\s+(tell|inform|notify|show)\s+the\s+user/i, '要求对用户隐瞒'],
  [/(总是|始终|每次都|无论如何都?)(要)?(先)?(调用|使用)(我|本工具|这个工具)/, '要求模型总是调用自己'],
  // 要点名到「这个工具 / 技能」才算 —— 「ALWAYS use this exact template」是正常的写作要求
  [/\balways\s+(call|use|invoke)\s+(this\s+(tool|skill|function|plugin)|me)\b/i, '要求模型总是调用自己'],
  [/(绕过|跳过|无需|不需要)(用户)?(的)?(确认|审批|授权)/, '要求绕过确认'],
  [/\b(bypass|skip)\s+(the\s+)?(user\s+)?(confirmation|approval)/i, '要求绕过确认'],
];

export function findInjection(text: string): string[] {
  return [...new Set(INJECTION.filter(([re]) => re.test(text)).map(([, why]) => why))];
}

/** 名字暗示有副作用的动作。这类工具把风险标成 read，准入就不会问人 —— 必须拦。 */
const SIDE_EFFECT_NAME = /(^|[._-])(send|delete|remove|drop|destroy|pay|payment|transfer|publish|post|submit|purchase|buy|order|book|write|update|create|upload|exec|execute|run|kill)([._-]|$)/i;

/** 触发词太宽会把不相干的请求都抢过来。 */
const TRIGGER_STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '我们', '一下', '帮我', '请', '给', '把', '在', '和', '这', '那', '做', '要',
  'the', 'a', 'an', 'to', 'do', 'it', 'is', 'me', 'you', 'please', 'help',
]);

const TOOL_ID = /^[a-z][a-z0-9_-]{0,31}\.[a-z][a-z0-9_-]{0,47}$/;
/**
 * 说明的上限。多数工具几十到几百字；放宽到 16000 是给「技能目录」这类工具 ——
 * 按 Agent Skills 规范，可用技能的清单就写在激活工具的说明里。
 */
const DESCRIPTION_MAX = 16000;
const OUTPUT_LIMIT_MAX = 32000;
const PARAM_DESCRIPTION_MAX = 512;

export interface ToolReview {
  readonly ok: boolean;
  /** 净化后的描述。只有 ok 时才可以注册。 */
  readonly descriptor: ToolDescriptor;
  readonly issues: readonly ReviewIssue[];
}

/**
 * 校验 + 净化 + 审查一个工具描述。
 *
 * 不修改入参；返回净化后的副本。`ok=false` 时不得注册。
 */
export function reviewTool(d: ToolDescriptor): ToolReview {
  const issues: ReviewIssue[] = [];
  const err = (message: string) => issues.push({ level: 'error', message });
  const warn = (message: string) => issues.push({ level: 'warn', message });

  // ── 校验 ──
  if (!TOOL_ID.test(String(d.id))) err(`工具 id 要写成「技能.名字」，只用小写字母、数字、- 和 _：${String(d.id)}`);
  if (!RISK_ORDER.includes(d.risk)) err(`风险等级无效：${String(d.risk)}`);
  if (!String(d.description ?? '').trim()) err('说明不能为空 —— 模型全靠它判断什么时候用这个工具');
  if (String(d.description ?? '').length > DESCRIPTION_MAX) warn(`说明超过 ${DESCRIPTION_MAX} 字，已截断`);
  if (d.outputLimit !== undefined && !(d.outputLimit > 0)) err('outputLimit 必须是正数');
  if ((d.outputLimit ?? 0) > OUTPUT_LIMIT_MAX) warn(`outputLimit 超过 ${OUTPUT_LIMIT_MAX}，已按上限处理`);

  const input = d.input ?? {};
  const props = (input['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  if (input['type'] !== undefined && input['type'] !== 'object') err('参数定义的顶层必须是 object');
  for (const r of (input['required'] ?? []) as string[]) {
    if (!(r in props)) err(`必填参数 ${r} 没有在 properties 里定义`);
  }
  for (const k of d.scopeKeys ?? []) {
    if (!(k in props)) err(`授权范围引用的参数 ${k} 不存在`);
  }
  for (const k of d.userSupplied ?? []) {
    if (!(k in props)) err(`userSupplied 引用的参数 ${k} 不存在`);
  }

  // ── 净化 ──
  const rawTexts = [d.description, ...Object.values(props).map((p) => String(p['description'] ?? '')), ...(d.triggers ?? [])];
  if (rawTexts.some((t) => hadHidden(String(t ?? '')))) warn('说明里有不可见字符（零宽、文字方向覆盖等），已去掉');
  // 说明保留原样（NFC）：NFKC 会把中文的全角标点「：，（」改成半角，模型读到半角说明，回答也跟着用半角
  const description = sanitizeText(d.description, DESCRIPTION_MAX, 'NFC');
  const cleanProps: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    cleanProps[k] = p['description'] !== undefined
      ? { ...p, description: sanitizeText(String(p['description']), PARAM_DESCRIPTION_MAX, 'NFC') }
      : p;
  }
  const triggers = (d.triggers ?? []).map((t) => sanitizeText(t, 32).toLowerCase()).filter(Boolean);

  // ── 审查 ──
  const allText = [description, ...Object.values(cleanProps).map((p) => String((p as Record<string, unknown>)['description'] ?? ''))].join('\n');
  // 审查用 NFKC 形式：全角、兼容字符折成标准形，拿形似字符改写的注入也能查出来
  for (const why of findInjection(allText.normalize('NFKC'))) err(`说明里有提示注入的写法：${why}`);
  const name = String(d.id).split('.')[1] ?? '';
  if (d.risk === 'read' && SIDE_EFFECT_NAME.test(name)) {
    err(`工具名「${name}」像是有副作用的操作，风险却标成了 read —— 这样执行前不会问用户。请如实标注风险`);
  }
  for (const t of triggers) {
    if (TRIGGER_STOPWORDS.has(t) || t.length < 2) err(`触发词「${t}」太宽泛，会把不相干的请求都抢过来`);
  }

  const descriptor: ToolDescriptor = {
    ...d,
    description,
    input: { ...input, properties: cleanProps } as JSONSchema,
    ...(d.triggers ? { triggers } : {}),
    ...(d.outputLimit ? { outputLimit: Math.min(d.outputLimit, OUTPUT_LIMIT_MAX) } : {}),
  };
  return { ok: !issues.some((i) => i.level === 'error'), descriptor, issues };
}

/** 风险比较：a 是否至少和 b 一样高。 */
export const riskAtLeast = (a: RiskClass, b: RiskClass): boolean => RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b);
