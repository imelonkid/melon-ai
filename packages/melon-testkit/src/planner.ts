import type { ContextBundle, ModelTool, PlanInput, PlanStep, Planner } from '@melon-ai/core';

/**
 * 按脚本依次产出 PlanStep 的假规划器。
 *
 * 脚本用尽时抛错 —— 静默返回 final 会让测试通过却掩盖「循环跑飞了」这类问题。
 */
export class ScriptedPlanner implements Planner {
  readonly kind = 'scripted';
  readonly inputs: PlanInput[] = [];
  private i = 0;

  constructor(private readonly script: readonly (PlanStep | ((input: PlanInput) => PlanStep))[]) {}

  async plan(input: PlanInput): Promise<PlanStep> {
    this.inputs.push(input);
    const item = this.script[this.i++];
    if (item === undefined) {
      throw new Error(`ScriptedPlanner 脚本用尽：这是第 ${this.i} 次规划，脚本只有 ${this.script.length} 条`);
    }
    return typeof item === 'function' ? item(input) : item;
  }
  get remaining(): number { return this.script.length - this.i; }
}

/** P0 的最小上下文：只够让管线和规划器跑起来，@melon-ai/context 就位后替换。 */
export function stubContext(tokens = 100): ContextBundle {
  return {
    messages: [], tools: [], slots: [], totalTokens: tokens, window: 200_000, watermark: 0.7,
  };
}

export const noTools: readonly ModelTool[] = [];
