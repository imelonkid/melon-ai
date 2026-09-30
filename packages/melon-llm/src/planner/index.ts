import type { PromptRef,
  ContextBundle, Intent, IntentClassifier, Message, ModelRouter, ModelTool, ModelToolCall,
  PlanInput, PlanStep, Planner, ToolCall,
} from '@melon-ai/core';
import { asCallId, asToolId } from '@melon-ai/core';
import { REACT_PROMPT, REACT_SYSTEM } from './prompt.js';
import {
  DEFAULT_ACTION_WORDS, asksConfirmation, claimsDone, confirmCorrection, correctionFor, isActionTool,
  matchActionTools, mentionsAction, supplyCorrection, unsuppliedValues,
} from './action.js';

export * from './prompt.js';
export * from './action.js';

export interface ReActOptions {
  readonly router: ModelRouter;
  /** 意图分类。不传则不做短路 —— 每轮都会带上工具。 */
  readonly classifier?: IntentClassifier;
  readonly system?: string;
  /** 自定义 `system` 的版本号，进事件日志。不传则自定义提示词不记版本。 */
  readonly promptRef?: PromptRef;
  /** 生成 callId / argsHash。宿主注入以保持确定性。 */
  readonly ids?: { next(prefix?: string): string };
  readonly hash?: (s: string) => string;
  /** 动作词表（「没有合适的工具」的判定依据）。默认 `DEFAULT_ACTION_WORDS`，宿主可扩充。 */
  readonly actionWords?: readonly string[];
}

/**
 * ReAct 规划器。
 *
 * ## 为什么用原生 tool use 而不是解析文本
 *
 * 让模型输出 `Action: mail.send\nArgs: {...}` 再正则解析，是 ReAct 论文时代的做法。
 * 现在供应商都有原生 tool use，它能保证**参数符合 schema**、**不会把动作写进正文**。
 * 解析文本的失败模式（漏字段、JSON 截断、把动作写在思考里）在生产里非常常见，
 * 而且每次失败都要烧一轮预算重来。
 *
 * ## 意图短路
 *
 * 闲聊与纯问答**完全不带工具**（见 architecture.md §2.7 与 kernel-design.md §6.1）。
 * 大部分对话轮次根本不需要工具，却常被无脑塞进全套 schema ——
 * 这是整条链路里最省的一笔。
 */
export class ReActPlanner implements Planner {
  readonly kind = 'react';
  private seq = 0;

  constructor(private readonly opts: ReActOptions) {}

  /** 每一步都带上提示词版本与实际应答的模型，由运行时写进事件日志（§10 第 67 条）。 */
  async plan(input: PlanInput, signal: AbortSignal): Promise<PlanStep> {
    let modelId: string | undefined;
    let egress: string | undefined;
    const step = await this.decide(input, signal, (id, to) => { modelId = id; egress = to; });
    const promptRef = this.opts.system === undefined ? REACT_PROMPT : this.opts.promptRef;
    return {
      ...step,
      via: { ...(promptRef ? { promptRef } : {}), ...(modelId ? { modelId } : {}), ...(egress ? { egress } : {}) },
    };
  }

  private async decide(input: PlanInput, signal: AbortSignal, answeredBy: (modelId: string, egress?: string) => void): Promise<PlanStep> {
    const { task } = input;
    const intent = await this.classify(input, signal);
    // 闲聊 / 纯问答：不召回、不注入任何 tool schema
    const tools: readonly ModelTool[] = intent === 'task' ? input.availableTools : [];
    const called = task.toolsCalled ?? [];
    const succeeded = task.toolsSucceeded ?? [];

    // ── 动作守卫①：命中了有副作用工具的触发词，而且还没尝试过 → 必须调用工具 ──
    const matched = matchActionTools(task.goal, tools);
    const mustAct = matched.some((t) => !called.includes(t.name));

    // ── 动作守卫②：要做一件事，却连一个有副作用的工具都没有 → 不问模型，直接说 ──
    // 只在「一个都没有」时才直接拒：有这类工具、只是说法没命中触发词（「发送周报」≠「发邮件」）时交给模型，
    // 它若编造或只用文字征求确认，③④会拦 —— 误拒比漏拦更糟，用户换个说法就被拒绝
    if (task.usage.steps === 0 && matched.length === 0) {
      const verb = mentionsAction(task.goal, this.opts.actionWords ?? DEFAULT_ACTION_WORDS);
      if (verb && !tools.some(isActionTool)) {
        return {
          kind: 'abort',
          thought: `动作词「${verb}」没有匹配的工具`,
          reason: `没有能完成「${verb}」的工具，这件事没有做。`,
        };
      }
    }

    const decision = await this.opts.router.select(intent === 'task' ? 'plan' : 'answer', signal);
    const messages = this.assemble(input.context, tools.length > 0);
    const generate = async (msgs: readonly Message[], required: boolean) => {
      const res = await decision.primary.generate({
        messages: msgs,
        ...(tools.length > 0 ? { tools, toolChoice: required ? 'required' as const : 'auto' as const } : {}),
        signal,
      });
      // 只用首选模型：路由给的 egress 与候选同序，第一个就是它
      answeredBy(res.modelId, decision.egress[0]);
      return res;
    };

    // ── 参数来源核对：「必须是用户给的」参数（收件人……），值得在用户说过的话里出现过 ──
    const userText = [task.goal, ...input.context.messages
      .filter((m) => m.role === 'user' && (m.from ?? 'user') === 'user').map((m) => m.content)].join('\n');
    const bad = (c: ModelToolCall) => unsuppliedValues((c.args ?? {}) as Record<string, unknown>, tools.find((t) => t.name === c.name), userText);
    const accept = async (text: string, c: ModelToolCall, base: readonly Message[]): Promise<PlanStep> => {
      const miss = bad(c);
      if (!miss) return this.toToolCall(text, c);
      // 退回一次：让它去问用户。这一轮不强制调工具 —— 缺的信息只能问用户
      const retry = await generate(
        [...base, { role: 'assistant', content: text.trim() || `（准备调用 ${c.name}）` }, { role: 'user', content: supplyCorrection(miss.field, miss.values) }],
        false,
      );
      const again = retry.toolCalls?.[0];
      if (again && !bad(again)) return this.toToolCall(retry.text, again);
      const answer = retry.text.trim();
      if (again || !answer) {
        return {
          kind: 'abort',
          thought: `参数 ${miss.field} 的值不是用户给的：${miss.values.join('、')}`,
          reason: `这件事没有做成：${miss.field} 需要你提供（Agent 填的「${miss.values.join('、')}」不是你给的），所以没有执行。`,
        };
      }
      return { kind: 'final', thought: '参数不是用户给的，改为向用户询问', answer };
    };

    const res = await generate(messages, mustAct);
    if (res.stopReason === 'filtered') {
      return { kind: 'final', thought: '被安全策略拦截', answer: res.text };
    }
    const call = res.toolCalls?.[0];
    if (call) return accept(res.text, call, messages);

    // ── 动作守卫③：答复里说做成了，本任务却没有成功执行过任何有副作用的工具 ──
    const answer = res.text.trim() || '（模型没有返回内容）';
    const claim = claimsDone(answer);
    const acted = succeeded.some((id) => {
      const t = input.availableTools.find((x) => x.name === id);
      return t ? isActionTool(t) : false;
    });
    if (claim && !acted) {
      // 纠正一次：它可能只是想先说后做，给它一次真的去调工具的机会
      const retry = await generate(
        [...messages, { role: 'assistant', content: answer }, { role: 'user', content: correctionFor(claim) }],
        tools.some(isActionTool),
      );
      const again = retry.toolCalls?.[0];
      if (again) return accept(retry.text, again, messages);
      const second = retry.text.trim();
      if (!second || claimsDone(second)) {
        return {
          kind: 'abort',
          thought: `模型声称「${claim}」，但没有执行任何对应的工具`,
          reason: `这件事没有做成：回答里说「${claim}」，但实际上没有执行任何对应的操作。`,
        };
      }
      return { kind: 'final', thought: '纠正后如实作答', answer: second };
    }

    // ── 动作守卫⑤：用户已经拒绝过某个操作，答复却又在用文字征求确认 ──
    // 拒绝后的回喂已经写明「别再用文字征求确认」，实测 DeepSeek 照样写「需要先确认一下收件人……」。
    // 用户已经做了决定，结果由规则给出，不用模型的话
    if ((task.denied ?? []).length > 0 && asksConfirmation(answer)) {
      return { kind: 'final', thought: `拒绝后模型又用文字征求确认（「${asksConfirmation(answer)}」），按用户的决定收尾`, answer: '你拒绝了这个操作，它没有执行。' };
    }

    // ── 动作守卫④：用文字征求对外操作的确认，而对应的工具本任务里一次都没调过 ──
    // 只看和这件事相关的工具（话里或答复里命中它的触发词），不去逼模型调不相干的工具
    const ask = asksConfirmation(answer);
    const untried = matchActionTools(`${task.goal}\n${answer}`, tools).filter((t) => !called.includes(t.name));
    if (ask && untried.length > 0) {
      const retry = await generate(
        [...messages, { role: 'assistant', content: answer }, { role: 'user', content: confirmCorrection }],
        true,
      );
      const again = retry.toolCalls?.[0];
      if (again) return accept(retry.text, again, messages);
      const second = retry.text.trim();
      if (!second || asksConfirmation(second) || claimsDone(second)) {
        return {
          kind: 'abort',
          thought: `模型用文字征求确认（「${ask}」），纠正后仍没有调用 ${untried.map((t) => t.name).join('、')}`,
          reason: '这件事没有做成：Agent 用文字征求确认，却没有发起操作，所以什么都没有执行。',
        };
      }
      return { kind: 'final', thought: '纠正后向用户问清缺的信息', answer: second };
    }

    // 没选工具 = 模型认为可以收敛了（包括向用户追问缺的信息）
    return { kind: 'final', thought: '模型未请求工具，视为可以作答', answer };
  }

  private async classify(input: PlanInput, signal: AbortSignal): Promise<Intent> {
    // 已经动过手（跑过工具）的任务不再重新分类 —— 中途判成闲聊会把工具收走
    if (input.task.usage.steps > 0) return 'task';
    if (!this.opts.classifier) return 'task';
    try {
      return await this.opts.classifier.classify(input.task.goal, signal);
    } catch {
      // 分类失败就按 task 走：宁可多带工具，也别让本该用工具的请求变成空谈
      return 'task';
    }
  }

  private assemble(ctx: ContextBundle, withTools: boolean): readonly Message[] {
    const system = this.opts.system ?? REACT_SYSTEM;
    const head: Message[] = [
      // 缓存断点：system 是最稳定的一段，放最前（§2.4 前缀稳定性）
      { role: 'system', content: system, cacheBoundary: true },
    ];
    if (!withTools) {
      head.push({ role: 'system', content: '本轮没有可用工具，请直接作答。' });
    }
    const body = ctx.messages.filter((m) => m.role !== 'system');
    // 上下文为空时给一个占位，避免供应商拒绝空 messages
    return body.length > 0 ? [...head, ...body] : [...head, { role: 'user', content: '（无历史）' }];
  }

  private toToolCall(text: string, call: ModelToolCall): PlanStep {
    const args = call.args ?? {};
    const canonical = JSON.stringify(args, Object.keys(args as object).sort());
    const toolCall: ToolCall = {
      callId: asCallId(this.opts.ids?.next('call') ?? `call-${++this.seq}`),
      toolId: asToolId(call.name),
      args,
      argsHash: this.opts.hash ? this.opts.hash(canonical) : simpleHash(canonical),
    };
    return { kind: 'tool_call', thought: text.trim() || `调用 ${call.name}`, call: toolCall };
  }
}

/**
 * 关键词意图分类。
 *
 * 不用模型：分类本身的判别质量不随模型上限提升，而每轮多一次模型往返是实打实的延迟。
 * 规则命中不了就返回 `task` —— 宁可多带工具。
 */
export class KeywordIntentClassifier implements IntentClassifier {
  constructor(
    private readonly chatPatterns: readonly RegExp[] = [
      /^(你好|您好|hi|hello|在吗|谢谢|多谢|再见)$/i,
      /^(你是谁|你叫什么|你能做什么)/,
    ],
  ) {}

  async classify(text: string): Promise<Intent> {
    const t = text.trim();
    if (t.length <= 12 && this.chatPatterns.some((r) => r.test(t))) return 'chat';
    return 'task';
  }
}

/** 非加密哈希，只用于循环检测与幂等 —— 授权用的是 policy 的可读 scope。 */
function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
