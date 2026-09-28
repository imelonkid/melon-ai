/**
 * ─── 提示词 ───
 * 这个模块**只做「命名 + 版本化模板 + 变量渲染」，不做提示词 DSL**。
 * 提示词框架的通病是把最终发给模型的文本藏在多层抽象后面，调试时看不见真正发出去的东西。
 *
 * 另一条边界：**parser 不在这里**。提示词的输出格式与读它的 parser 之间是隐式契约，
 * 拆到两个包里必然漂移。消费方自己持有 parser，按 PromptRef 引用模板。
 */

export interface PromptRef {
  readonly name: string;
  readonly version: string;
}

export interface PromptTemplate {
  readonly name: string;
  readonly version: string;
  readonly text: string;
  /** 模板里出现的变量名。渲染时缺变量应当报错，而不是静默留空。 */
  readonly variables: readonly string[];
  /** 某些模型需要不同的提示词方言（XML 标签 vs JSON schema）。 */
  readonly dialect?: string;
}

export interface RenderedPrompt {
  readonly text: string;
  /** 用了哪一版。**这个值要进事件日志** —— 否则重放对不上，可重放性名存实亡。 */
  readonly ref: PromptRef;
}

export interface PromptRegistry {
  /** 不传 version 取当前默认版本。 */
  get(name: string, version?: string): PromptTemplate;
  render(name: string, vars: Readonly<Record<string, string>>, version?: string): RenderedPrompt;
  list(): readonly PromptRef[];
  register(template: PromptTemplate): void;
}
