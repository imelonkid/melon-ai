/**
 * 图片生成协议。和搜索一样，各家接口不同：引擎只定这份约定，技能（`@melon-ai/skills/images`）只认它，
 * 具体厂商（智谱 CogView / GLM-Image……）的实现放在 `@melon-ai/plugins` 的子路径里。
 */
import type { Currency } from './usage.js';

export interface ImageRequest {
  readonly prompt: string;
  /** 「1024x1024」这类。不填用厂商的默认。 */
  readonly size?: string;
}

export interface GeneratedImage {
  readonly data: Uint8Array;
  readonly mime: string;
}

/**
 * 生图服务。实现方的约定：失败抛 `ToolError`（key 无效 `DENIED`、余额不足 `FATAL` 带「余额不足」、限流 `RATE_LIMITED`、其余 `UPSTREAM`）；
 * 尊重 `signal`；返回图片的字节（厂商给的是临时链接的，自己下载好）。
 */
export interface ImageGenerator {
  /** 厂商，如 'zhipu'。记账用。 */
  readonly vendor: string;
  /** 模型 id，如 'cogview-3-flash'。 */
  readonly model: string;
  /** 给人看的名字，如「CogView-3-Flash（免费）」。 */
  readonly label: string;
  /** 每张的价格；免费的写 0；不知道就不填（只记次数）。 */
  readonly price?: { readonly amount: number; readonly currency: Currency };
  /** 支持的尺寸。第一个是默认。 */
  readonly sizes: readonly string[];
  generate(req: ImageRequest, signal?: AbortSignal): Promise<readonly GeneratedImage[]>;
}
