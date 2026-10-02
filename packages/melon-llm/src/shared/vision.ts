import type { Message } from '@melon-ai/core';

/**
 * 按模型名判断能不能看图（厂商价格页写了「输入模态」的，以那个为准 —— 见价格同步）。
 * 智谱 GLM-5.3-Flash / FlashX 是原生多模态，GLM-xV 是视觉模型；通义 Qwen-VL / QVQ；OpenAI GPT-4o 以后；Claude 全系；Kimi 的 vision 版。
 * DeepSeek 的 API 不能看图。宁可漏判（用户可以在资源页手动打开），不可错判（发了图却看不了）。
 */
const VISION = [
  /^glm-5\.\d+-flash(x)?$/i, /^glm-\d(\.\d+)?v/i, /^glm-4v/i,
  /qwen[\w.-]*-vl/i, /^qvq/i, /qwen3?-omni/i,
  /^gpt-4o/i, /^gpt-4\.1/i, /^gpt-5/i, /^o[34](-|$)/i, /^chatgpt-4o/i,
  /^claude/i,
  /vision/i, /kimi-k2\.5|kimi-latest/i,
];

export const visionByName = (model: string): boolean => VISION.some((re) => re.test(model));

/** 一条消息有没有已经读出内容的图片。 */
export const imagesOf = (m: Message): readonly { mime: string; data: string }[] =>
  (m.images ?? []).filter((i): i is { ref: never; mime: string; data: string } => typeof i.data === 'string' && i.data.length > 0);
