import type { PromptRef,
  ContextBundle, GenerateResult, Intent, IntentClassifier, Message, ModelRouter, ModelTool, ModelToolCall,
  PlanInput, PlanStep, Planner, ToolCall, Usage,
} from '@melon-ai/core';
import { MAX_REASONING_CHARS, asCallId, asToolId } from '@melon-ai/core';
import { REACT_PROMPT, REACT_SYSTEM } from './prompt.js';
import {
  DEFAULT_ACTION_WORDS, asksConfirmation, claimsDone, confirmCorrection, correctionFor, isActionTool,
  matchActionTools, mentionsAction, supplyCorrection, unsuppliedValues, unbackedValues, unbackedCorrection } from './action.js';

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
  /** 这个任务要不要思考（宿主按定制 Agent 给）。不传、返回空都用模型的默认。 */
  readonly thinkingOf?: (task: PlanInput['task']) => 'off' | 'auto' | undefined;
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
/** 流式草稿末尾先不显示的字数：要比守卫认得出的说法（「已经成功发送」「has been sent」）长。 */
const DRAFT_HOLD = 16;

export class ReActPlanner implements Planner {
  readonly kind = 'react';
  private seq = 0;

  constructor(private readonly opts: ReActOptions) {}

  /** 每一步都带上提示词版本与实际应答的模型，由运行时写进事件日志（§10 第 67 条）。 */
  async plan(input: PlanInput, signal: AbortSignal): Promise<PlanStep> {
    let modelId: string | undefined;
    // 数据去向：这一步发给过的每一家（换过模型时不止一家），都要进审计
    const egress = new Set<string>();
    // 这一步可能问了模型好几次（守卫纠正、参数退回），每次的思考都留下 —— 看的人要知道它为什么改了主意
    const thoughts: string[] = [];
    // 每次的真实用量都加上：任务的费用预算靠它生效
    let usage: Usage | undefined;
    const step = await this.decide(input, signal, (res, fallbackEgress) => {
      modelId = res.modelId;
      for (const f of res.failedAttempts ?? []) egress.add(f.egress);
      const to = res.egress ?? fallbackEgress;
      if (to) egress.add(to);
      if (res.reasoning?.trim()) thoughts.push(res.reasoning.trim());
      usage = addUsage(usage, res.usage);
    });
    const promptRef = this.opts.system === undefined ? REACT_PROMPT : this.opts.promptRef;
    const reasoning = thoughts.join('\n\n———\n\n').slice(0, MAX_REASONING_CHARS);
    return {
      ...step,
      via: {
        ...(promptRef ? { promptRef } : {}), ...(modelId ? { modelId } : {}),
        ...(egress.size ? { egress: [...egress].join(',') } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  }

  private async decide(
    input: PlanInput, signal: AbortSignal,
    answeredBy: (res: GenerateResult, fallbackEgress?: string) => void,
  ): Promise<PlanStep> {
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

    // 为谁问、问来做什么：路由按它套规则（任务类别、最低档、固定模型），记账也按它
    const meta = {
      taskId: task.id, agentId: task.agentId, taskKind: task.kind, trigger: task.trigger.type,
      ...(task.trigger.ref !== undefined ? { triggerRef: task.trigger.ref } : {}),
      purpose: intent === 'task' ? 'plan' as const : 'answer' as const,
    };
    // 带工具的一轮只给支持工具的模型
    // 带图的一轮只给能看图的模型
    const needsVision = input.context.messages.some((m) => (m.images?.length ?? 0) > 0);
    const decision = await this.opts.router.select(meta.purpose, signal, { needsTools: tools.length > 0, ...(needsVision ? { needsVision } : {}), meta });
    const messages = this.assemble(input.context, tools.length > 0);
    const acted = succeeded.some((id) => {
      const t = input.availableTools.find((x) => x.name === id);
      return t ? isActionTool(t) : false;
    });
    const toolResults = input.context.messages.filter((m) => m.from === 'tool').map((m) => m.content).join('\n');

    // ── 流式：回答边生成边交给宿主显示 ──
    // 显示出去的话收不回来：「邮件已发送」先被用户看到、再被守卫打回，比不显示更糟。
    // 所以守卫③④⑤在流式过程中就对已收到的文本查，命中立刻停止显示并撤回；最终结论仍由下面的守卫给出
    const draft = input.draft;
    let shown = false;
    const retract = (reason: 'tool' | 'check' | 'retry'): void => {
      if (shown) { shown = false; draft?.({ kind: 'reset', reason }); }
    };
    const wouldCorrect = (text: string): boolean => {
      const claim = claimsDone(text);
      if (claim && (!acted || unbackedValues(text, toolResults).length > 0)) return true;
      if (!asksConfirmation(text)) return false;
      return (task.denied ?? []).length > 0
        || matchActionTools(`${task.goal}\n${text}`, tools).some((t) => !called.includes(t.name));
    };
    const thinking = this.opts.thinkingOf?.(task);
    const generate = async (msgs: readonly Message[], required: boolean, maxOutputTokens?: number) => {
      // 必须调工具的一轮不会有回答，不流式
      let held = false;
      const onText = draft && !required
        ? (text: string) => {
            if (held) return;
            if (wouldCorrect(text)) { held = true; retract('check'); return; }
            // 末尾留几个字先不显示：「已发送」可能被切在两段里，只显示「邮件已发」也是在说做成了。
            // 守卫查的是收到的全文，显示的总比查过的少一截；最终回答随任务结果到，不靠草稿补齐
            const safe = text.slice(0, Math.max(0, text.length - DRAFT_HOLD));
            if (!safe.trim()) return;
            shown = true;
            draft({ kind: 'text', text: safe });
          }
        : undefined;
      const res = await decision.primary.generate({
        messages: msgs,
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(thinking ? { thinking } : {}),
        ...(tools.length > 0 ? { tools, toolChoice: required ? 'required' as const : 'auto' as const } : {}),
        signal,
        ...(onText ? { onText } : {}),
        // 思考不是回答：不过守卫、不留尾巴，原样交出去当过程显示
        ...(draft ? { onReasoning: (text: string) => { if (text.trim()) draft({ kind: 'thinking', text }); } } : {}),
        meta,
        // 上一个模型说到一半出错、换了一个从头来：已显示的半截收起，守卫状态也重来
        onRetry: () => { held = false; retract('retry'); },
      });
      // 先说一句「我先搜一下」再调工具：那是过程话，不是回答
      if (res.toolCalls?.length) retract('tool');
      // 只用首选模型：路由给的 egress 与候选同序，第一个就是它
      answeredBy(res, decision.egress[0]);
      return res;
    };

    // ── 参数来源核对：「必须是用户给的」参数（收件人……），值得在用户说过的话里出现过 ──
    const userText = [task.goal, ...input.context.messages
      // 记忆也算：它来自用户之前的原话（写入时过了污点与注入审查）——「发到我的邮箱」要能用上记住的地址
      .filter((m) => m.role === 'user' && ['user', 'memory'].includes(m.from ?? 'user')).map((m) => m.content)].join('\n');
    const bad = (c: ModelToolCall) => unsuppliedValues((c.args ?? {}) as Record<string, unknown>, tools.find((t) => t.name === c.name), userText);
    const accept = async (text: string, c: ModelToolCall, base: readonly Message[], rest: readonly ModelToolCall[] = []): Promise<PlanStep> => {
      const miss = bad(c);
      // 同一轮里其余的调用排队依次执行；参数来源不对的不排（它们没机会被退回去问用户）
      if (!miss) return this.toToolCall(text, c, rest.filter((x) => !bad(x)));
      // 退回一次：让它去问用户。这一轮不强制调工具 —— 缺的信息只能问用户
      retract('check');
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

    let res = await generate(messages, mustAct);
    // 输出到了上限还没写完（多半是思考太长，或者一次要写的内容太多）：加大上限再试一次。
    // 不试的话，什么都没写出来的会被当成「（模型没有返回内容）」的回答、任务还算完成
    if (res.stopReason === 'length' && !res.toolCalls?.length) {
      const was = decision.primary.capabilities.maxOutputTokens;
      retract('retry');
      const tooLong = {
        kind: 'abort' as const,
        thought: '输出到了上限，没有写出回答或调用',
        reason: '这次没有做成：模型的输出到了上限还没写完（思考太长，或者一次要写的内容太多）。可以把要求拆小一点再说一次，或者换一个模型。',
      };
      // 有的模型不接受更大的上限（直接报错）：同样说清楚，不让任务以一个莫名的错误结束
      try { res = await generate(messages, mustAct, Math.max(32_000, was * 4)); } catch (e) {
        if (signal.aborted) throw e;
        return tooLong;
      }
      if (res.stopReason === 'length' && !res.toolCalls?.length) {
        if (!res.text.trim()) return tooLong;
        return { kind: 'final', thought: '回答到了输出上限，没写完', answer: `${res.text.trim()}\n\n（回答太长，到了输出上限，后面没写完）` };
      }
    }
    if (res.stopReason === 'filtered') {
      return { kind: 'final', thought: '被安全策略拦截', answer: res.text };
    }
    // 模型一次可能给好几个调用（「叫我 X，邮箱是 Y」→ 记两条）。初版只执行第一个、其余悄悄丢掉，
    // 模型却以为都做了，回答「邮箱我记下了」（§10 第 77 条）—— 其余的排队，逐个走准入与守卫
    const call = res.toolCalls?.[0];
    if (call) return accept(res.text, call, messages, res.toolCalls?.slice(1) ?? []);

    // ── 动作守卫③：答复里说做成了，本任务却没有成功执行过任何有副作用的工具 ──
    const answer = res.text.trim() || '（模型没有返回内容）';
    const claim = claimsDone(answer);
    // 做过一件事，不等于说到的每一件都做了：提到的邮箱、网址、手机号要在工具结果里出现过
    const unbacked = claim && acted ? unbackedValues(answer, toolResults) : [];
    if (claim && (!acted || unbacked.length > 0)) {
      // 纠正一次：它可能只是想先说后做，给它一次真的去调工具的机会
      retract('check');
      const retry = await generate(
        [...messages, { role: 'assistant', content: answer }, {
          role: 'user',
          content: unbacked.length > 0 ? unbackedCorrection(claim, unbacked) : correctionFor(claim),
        }],
        tools.some(isActionTool),
      );
      const again = retry.toolCalls?.[0];
      if (again) return accept(retry.text, again, messages);
      const second = retry.text.trim();
      const stillUnbacked = unbacked.length > 0 && unbackedValues(second, toolResults).length > 0 && !!claimsDone(second);
      if (!second || (unbacked.length === 0 && claimsDone(second)) || stillUnbacked) {
        return {
          kind: 'abort',
          thought: `模型声称「${claim}」，但没有执行任何对应的工具${unbacked.length ? `（${unbacked.join('、')}）` : ''}`,
          reason: unbacked.length
            ? `有一部分没有做成：回答里说「${claim}」，但实际上没有对 ${unbacked.join('、')} 执行任何操作。`
            : `这件事没有做成：回答里说「${claim}」，但实际上没有执行任何对应的操作。`,
        };
      }
      return { kind: 'final', thought: '纠正后如实作答', answer: second };
    }

    // ── 动作守卫⑤：用户已经拒绝过某个操作，答复却又在用文字征求确认 ──
    // 拒绝后的回喂已经写明「别再用文字征求确认」，实测 DeepSeek 照样写「需要先确认一下收件人……」。
    // 用户已经做了决定，结果由规则给出，不用模型的话
    if ((task.denied ?? []).length > 0 && asksConfirmation(answer)) {
      retract('check');
      return { kind: 'final', thought: `拒绝后模型又用文字征求确认（「${asksConfirmation(answer)}」），按用户的决定收尾`, answer: '你拒绝了这个操作，它没有执行。' };
    }

    // ── 动作守卫④：用文字征求对外操作的确认，而对应的工具本任务里一次都没调过 ──
    // 只看和这件事相关的工具（话里或答复里命中它的触发词），不去逼模型调不相干的工具
    const ask = asksConfirmation(answer);
    const untried = matchActionTools(`${task.goal}\n${answer}`, tools).filter((t) => !called.includes(t.name));
    if (ask && untried.length > 0) {
      retract('check');
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

  private toToolCall(text: string, call: ModelToolCall, rest: readonly ModelToolCall[] = []): PlanStep {
    const then = rest.map((c) => this.makeCall(c));
    return {
      kind: 'tool_call', thought: text.trim() || `调用 ${call.name}`, call: this.makeCall(call),
      ...(then.length > 0 ? { then } : {}),
    };
  }

  private makeCall(call: ModelToolCall): ToolCall {
    const args = call.args ?? {};
    const canonical = JSON.stringify(args, Object.keys(args as object).sort());
    return {
      callId: asCallId(this.opts.ids?.next('call') ?? `call-${++this.seq}`),
      toolId: asToolId(call.name),
      args,
      argsHash: this.opts.hash ? this.opts.hash(canonical) : simpleHash(canonical),
    };
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

/**
 * 一步里多次问模型的用量相加。折美元的费用有就加（预算宁可少算一点也要生效）；
 * 按币种的费用只在每次都有、币种相同时才加 —— 有一次没价格，这个总数就不可信。
 */
function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  const cost = a.cost && b.cost && a.cost.currency === b.cost.currency
    ? { cost: { amount: a.cost.amount + b.cost.amount, currency: a.cost.currency } } : {};
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    ...(a.costUSD !== undefined || b.costUSD !== undefined ? { costUSD: (a.costUSD ?? 0) + (b.costUSD ?? 0) } : {}),
    ...cost,
  };
}

/** 非加密哈希，只用于循环检测与幂等 —— 授权用的是 policy 的可读 scope。 */
function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
