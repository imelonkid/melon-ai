import type {
  ContextBundle, Intent, IntentClassifier, Message, ModelRouter, ModelTool, ModelToolCall,
  PlanInput, PlanStep, Planner, ToolCall,
} from '@melon-ai/core';
import { asCallId, asToolId } from '@melon-ai/core';
import { REACT_PROMPT, REACT_SYSTEM } from './prompt.js';

export * from './prompt.js';

export interface ReActOptions {
  readonly router: ModelRouter;
  /** 意图分类。不传则不做短路 —— 每轮都会带上工具。 */
  readonly classifier?: IntentClassifier;
  readonly system?: string;
  /** 生成 callId / argsHash。宿主注入以保持确定性。 */
  readonly ids?: { next(prefix?: string): string };
  readonly hash?: (s: string) => string;
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

  async plan(input: PlanInput, signal: AbortSignal): Promise<PlanStep> {
    const intent = await this.classify(input, signal);
    // 闲聊 / 纯问答：不召回、不注入任何 tool schema
    const tools: readonly ModelTool[] = intent === 'task' ? input.availableTools : [];

    const decision = await this.opts.router.select(intent === 'task' ? 'plan' : 'answer', signal);
    const messages = this.assemble(input.context, tools.length > 0);

    const res = await decision.primary.generate({
      messages,
      ...(tools.length > 0 ? { tools, toolChoice: 'auto' as const } : {}),
      signal,
    });

    if (res.stopReason === 'filtered') {
      return { kind: 'final', thought: '被安全策略拦截', answer: res.text };
    }

    const call = res.toolCalls?.[0];
    if (call) return this.toToolCall(res.text, call);

    // 没选工具 = 模型认为可以收敛了
    return {
      kind: 'final',
      thought: '模型未请求工具，视为可以作答',
      answer: res.text.trim() || '（模型没有返回内容）',
    };
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
