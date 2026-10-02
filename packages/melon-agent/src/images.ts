/**
 * `@melon-ai/agent/images` —— 内置技能「生成图片」（Node 宿主）：按描述画图，图片存进输出目录，作为生成的文件交给宿主显示。
 *
 * ```ts
 * import { images } from '@melon-ai/agent/images';
 * import { zhipuImages } from '@melon-ai/plugins/zhipu';
 * await agent.configure({ skills: [images({ generator: zhipuImages({ apiKey, model: 'cogview-3-flash' }), dir: outputsDir })] });
 * ```
 *
 * 描述会发给生图厂商（对外操作：第一次先问，可以始终允许）；每次生成按张记进用量账本。
 */
export { images } from '@melon-ai/skills/images';
export type { ImagesOptions } from '@melon-ai/skills/images';
