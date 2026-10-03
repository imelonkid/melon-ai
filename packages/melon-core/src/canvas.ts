/**
 * 画布：Agent 生成、用户和 Agent 都能改的一份结构化内容（聊天记录体、周报版式、行程卡片……）。
 *
 * 引擎只管数据和版本：内容是一份 JSON（`doc`），每改一次（不管是 Agent 用工具改的，还是用户在界面上改的）追加一个版本。
 * 怎么画由宿主决定（模板 + 数据）—— 换个宿主（CLI、网页）同样能读写同一份画布。
 */

export interface CanvasVersion {
  readonly canvasId: string;
  /** 哪种画布（`CanvasKind.kind`）。 */
  readonly kind: string;
  /** 从 1 开始，每次 +1。 */
  readonly version: number;
  readonly doc: unknown;
  /** 谁改的：Agent（工具）还是用户（界面上直接改）。 */
  readonly by: 'agent' | 'user';
  readonly at: number;
  readonly taskId?: string;
  /** 这次改了什么（给人看，也进上下文）。 */
  readonly note?: string;
}

/** 画布的版本存档。`append` 的版本号必须是最新版本 + 1，否则抛 `ConflictError`（两边同时改）。 */
export interface CanvasStore {
  append(v: CanvasVersion): Promise<void>;
  latest(canvasId: string): Promise<CanvasVersion | null>;
  get(canvasId: string, version: number): Promise<CanvasVersion | null>;
  /** 最新的在前。 */
  history(canvasId: string, limit?: number): Promise<readonly CanvasVersion[]>;
}

/** 一种画布：宿主给的数据形状（JSON Schema）和写法说明（告诉模型每个字段是什么、怎么改）。 */
export interface CanvasKind {
  readonly kind: string;
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly instructions: string;
}
