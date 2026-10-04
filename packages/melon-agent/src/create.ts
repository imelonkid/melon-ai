import type {
  CanvasKind, CanvasVersion, ThinkingLevel, SpendGuard,
  AgentProfile,
  AgentId, AnswerDraft, ApprovalDecision, AuditSink, Grant, Memory, Budget, ContextBundle, IdempotencyStore, LogLevel, ModelEntry,
  ModelTool, Planner, Platform, PolicyMode, QuotaSnapshot, RetentionPolicy, Schedule, ScheduleId,
  ScheduleStatus, SchemaValidator, Sequenced, SkillProvider, StoreBundle, Task, TaskEvent, TaskId,
  TaskKind, TaskState, ToolResolver, ToolsetSnapshot, UsageQuery, UsageRecord, RouteContext, PriceSource, PriceSync,
  ModelProvider, VendorCatalog, ModelListing, Attachment,
} from '@melon-ai/core';
import { TERMINAL_STATES, asAgentId, asScheduleId, asToolId } from '@melon-ai/core';
import { describeRule, whenToRule } from '@melon-ai/engine';
import type { CreateScheduleInput, Scheduler, UpdateScheduleInput, When } from '@melon-ai/engine';
import {
  DEFAULT_ACTION_WORDS, HeuristicTokenizer, KeywordIntentClassifier, ModelCatalog, ModelPool, PriceBook, ReActPlanner, isAccountError, summarizeUsage, testModel,
} from '@melon-ai/llm';
import type {
  AccountProblem, FxRates, ModelTestResult, RouteExplanation, RouteStrategy, RoutingRule, RoutingRules, SummaryOptions, UsageSummary,
} from '@melon-ai/llm';
import {
  applyPatch, canvas, diffPaths, ToolRegistry, activeMemories, artifact, basicValidator, memory, schedule } from '@melon-ai/skills';
import type { PatchOp, Tool } from '@melon-ai/skills';
import { memoryStorage } from '@melon-ai/store';
import { assemble } from './assemble.js';
import type { AssembledAgent } from './assemble.js';
import { basicContext } from './context.js';
import { SUMMARY_PROMPT, fitContext } from './budget.js';
import { withMemory } from './memory.js';
import { defaultPlatform } from './platform.js';

/** 存储：全套端口 + 审计 sink（+ 可选的幂等表）。`memoryStorage()` 与 `sqlite()` 都满足。 */
export type Storage = StoreBundle & { readonly audit: AuditSink; readonly idempotency?: IdempotencyStore };

export interface AgentOptions {
  /** 可用的模型。多个时按 `strategy` 路由。例：`[deepseek({ apiKey }), claude({ apiKey })]` */
  readonly models?: readonly ModelEntry[];
  /** 多模型时的路由策略。默认 balanced。 */
  readonly strategy?: RouteStrategy;
  /**
   * 计量：每次问模型的用量与费用进账本（`agent.usage`），任务的费用预算按真实花费生效。
   * - `fx`：汇率，1 美元 = 多少该币种（默认 CNY 7.2）。引擎不去拉汇率。
   * - `maxAttempts`：一次调用最多试几个模型（含首选），失败换下一个。默认 2。
   * - `retentionDays`：明细保留多少天，超过的按天汇总。默认 90。
   */
  readonly metering?: { readonly fx?: FxRates; readonly maxAttempts?: number; readonly retentionDays?: number };
  /**
   * 路由规则（策略为 `auto` 时生效）：这次调用属于哪类任务、最低要什么档、有没有固定的模型。
   * 不给时所有调用同一类、不限档。
   */
  readonly routing?: RoutingRules;
  /**
   * 价格同步：从各家官方价格文档拉取（来源在 `@melon-ai/plugins` 的各厂商子路径）。
   * 默认每 24 小时一次；失败保留上次的价格；变化超过 5 倍的等确认。
   */
  readonly pricing?: { readonly sources?: readonly PriceSource[]; readonly intervalHours?: number };
  /**
   * 跟随厂商最新可用的模型：每家拉一次这个账号能用的模型（`/models`），和官方价格取交集、自动定档，加入路由。
   * 与 `models`（固定的条目）并存。用户的改动（关掉、改档次、手填价格、手动加）在 `ModelProvider.overrides` 里。
   */
  readonly providers?: readonly ModelProvider[];
  /** 模型列表多久重新拉一次。默认 24 小时；连接配置（指纹）变了立即拉。 */
  readonly catalog?: { readonly intervalHours?: number };
  /** 存储。不传 = 内存（进程退出即丢失）；要持久化用 `@melon-ai/agent/sqlite`。 */
  readonly storage?: Storage;
  /** 宿主自己的工具，用 `defineTool` 定义。 */
  readonly tools?: readonly Tool[];
  /**
   * 技能来源，实现 `SkillProvider`：内置的联网（`/web`）、发邮件（`/mail`），
   * 用户装的 Agent Skills（`/agentskills`），将来的 MCP。
   * 「读取完整内容」是内置的，总是在，不用传。
   */
  readonly skills?: readonly SkillProvider[];
  /**
   * 定制 Agent：各自的说明书、能用哪些技能（`run(goal, { agentId })` 选用哪个）。没有定义的 Agent 不受限。
   */
  readonly agents?: readonly AgentProfile[];
  /**
   * 画布的种类：每种的数据形状（JSON Schema）和写法说明。对话绑定画布（`run(goal, { canvas })`）时，
   * Agent 拿到 `canvas.read` / `canvas.update`，当前内容和用户在界面上改过的地方进上下文。
   */
  readonly canvasKinds?: readonly CanvasKind[];
  /**
   * 让 Agent 可以拟定时任务草稿（内置工具 `schedule.propose`）。默认关 ——
   * 草稿要宿主画成卡片给用户确认，不支持的宿主开了，模型会以为草稿已经给用户看了。
   * 传 `{ when }` 可以收窄到某些任务（比如只在对话里）；默认是「不是定时触发的任务」。
   */
  readonly scheduleDrafts?: boolean | { readonly when?: (task: Task) => boolean };
  /**
   * 跨对话记忆（内置的记住 / 回忆 / 忘掉三个工具，每轮开始前把记忆带进上下文）。默认关。
   * 只记用户明确让记的；读过网页的任务里写记忆要用户确认；删除每次都确认。
   * `{ enabled }` 让宿主随时开关（设置页的开关），关着时工具不给模型、也不带记忆。
   */
  readonly memory?: boolean | { readonly enabled?: () => boolean };
  /**
   * 上下文预算（token，不含系统提示与工具定义）。超出时按段压缩：旧的工具结果截短 → 之前的对话摘要 → 较早的步骤摘要。
   * 摘要用路由的 `compact`（宿主可以把它路由到便宜的模型），照常记账。默认 24000；`false` 不压缩。
   */
  readonly contextBudget?: number | false;
  /**
   * 动作词：话里有这些词、却没有任何工具能做时，引擎直接回答「没有合适的工具」，不让模型编。
   * 在默认词表（`DEFAULT_ACTION_WORDS`）基础上**追加**。
   */
  readonly actionWords?: readonly string[];
  /**
   * 执行权限。默认 `low-risk-auto`：读与本地写自动，对外操作要确认。
   * （`ask` 会让只读工具也弹审批，点一次运行要批好几次 —— §10 第 35 条）
   */
  readonly policy?: PolicyMode | ((task: Task) => PolicyMode);
  /** 默认的 Agent 标识。`run()` 不指定时用它。 */
  readonly agentId?: string;
  /** 创建后立即启动（崩溃恢复 + 定时轮询）。默认 true。 */
  readonly start?: boolean;
  /** 未传 `platform` 时的日志级别。默认 info。 */
  readonly logLevel?: LogLevel;

  // ── 进阶：替换默认部件 ──
  /** 上下文装配。默认「任务目标 + 最近的步骤」（`basicContext`）。 */
  readonly context?: (task: Task) => Promise<ContextBundle>;
  /** 规划器。默认 ReAct（用 `models` 路由）。 */
  readonly planner?: Planner;
  /** 参数校验。默认 `basicValidator`（JSON Schema 的常用子集）。 */
  readonly validator?: SchemaValidator;
  /** 时间、随机、日志、哈希、链路。默认 `defaultPlatform()`（只用 Web 标准 API）；Node 上可换 `@melon-ai/agent/node` 的 `nodePlatform()`。 */
  readonly platform?: Platform;
  readonly retention?: RetentionPolicy;
  readonly quotaOf?: (agentId: AgentId) => Promise<QuotaSnapshot | null>;
  /**
   * 花钱前的检查（宿主的额度）：每次问模型、每次用按次计费的工具之前问一次，返回原因就不花 ——
   * 模型换下一家（都不行就以这个原因结束），工具不执行。额度怎么算是宿主的事（可以用 `agent.usage` 的账本）。
   */
  readonly spendGuard?: SpendGuard;
  readonly execute?: { timeoutMs?: number; maxRetries?: number; backoffBaseMs?: number };
  readonly pollIntervalMs?: number;
  /** 定时轮询间隔。默认 30s。 */
  readonly schedulePollMs?: number;
  readonly recallSkills?: (task: Task, query: string) => Promise<readonly string[]>;

  // ── 兼容：底层写法（assemble 的入参）──
  readonly stores?: Storage;
  readonly resolver?: ToolResolver;
  readonly buildContext?: (task: Task) => Promise<ContextBundle>;
  readonly availableTools?: (task: Task) => Promise<readonly ModelTool[]>;
  readonly toolset?: () => ToolsetSnapshot;
  readonly onSubmitted?: (task: Task) => void;
}

export interface RunOptions {
  readonly agentId?: string;
  readonly kind?: TaskKind;
  /**
   * 宿主自己的关联标识，原样记在 `task.trigger.ref`。
   * 例：对话 id —— 宿主用它把几轮串成一次对话，或在 `when` 里判断「是不是对话」。
   */
  readonly ref?: string;
  readonly budget?: Partial<Budget>;
  /**
   * 用户随这一轮给的文件。新的：文字已抽好（Node 宿主用 `@melon-ai/agent/files` 的 `prepareAttachment(path)`）；
   * 沿用之前轮次的：直接传那一轮 `task.attachments` 里的项（追问「这个表第三行是什么」时模型还读得到）。
   */
  readonly attachments?: readonly (NewAttachment | Attachment)[];
  /** 绑定一块画布（宿主给 id，同一个对话用同一个 id）。种类要在 `canvasKinds` 里。 */
  readonly canvas?: { readonly id: string; readonly kind: string };
  /** `false`：这一轮不带工具（直接问答）。要做事时任务以 `outcome.code: 'needs-tools'` 结束，宿主引导用户换个方式。 */
  readonly tools?: boolean;
  /** 思考力度：关 / 低 / 中 / 高。优先于定制 Agent 的默认；不给用 Agent 的或模型的默认。 */
  readonly thinking?: ThinkingLevel;
}

/** 一个新附件：名字、大小、说明，加上抽出的文字或图片本身（二选一）。 */
export interface NewAttachment {
  readonly name: string;
  readonly size: number;
  readonly note: string;
  readonly text?: string;
  /** 图片：发给能看图的模型。宿主先压好尺寸（长边 2048 以内）。 */
  readonly image?: { readonly data: Uint8Array; readonly mime: string };
}

/** `schedules.create` 的友好写法：写目标和「什么时候」，其余有默认值。 */
export interface ScheduleInput {
  readonly goal: string;
  readonly when: When;
  readonly title?: string;
  readonly agentId?: string;
  readonly kind?: TaskKind;
  /** 停机期间错过的触发：skip = 只补一次（默认），all = 每次都补。 */
  readonly catchUp?: 'skip' | 'all';
}

export interface Schedules {
  /** 新建。`when` 写法见 `When`；规则非法（时间已过、没选星期）时抛错并带原因。 */
  create(input: ScheduleInput | CreateScheduleInput): Promise<Schedule>;
  /** 改配置走版本链：返回新的一条，旧的指向它（§2.5）。 */
  update(id: string, patch: UpdateScheduleInput): Promise<Schedule>;
  pause(id: string): Promise<Schedule>;
  resume(id: string): Promise<Schedule>;
  /** 停用，不物理删 —— 历史任务还指着它。 */
  remove(id: string): Promise<Schedule>;
  get(id: string): Promise<Schedule | null>;
  list(status?: ScheduleStatus): Promise<readonly Schedule[]>;
  /** 「每周五 16:00」「仅一次 · 10月2日 09:00」。 */
  describe(schedule: Schedule): string;
  /** 立即跑一轮到期检查（测试与宿主自控节奏用）。 */
  tick(): Promise<number>;
}

export interface AgentEvents {
  /** 任何任务有了新进展（新建、每一步、结束）。给的是最新的任务。 */
  task: (task: Task) => void;
  /** 定时任务新建、修改、暂停、恢复、删除，或刚触发了一次。 */
  schedule: (schedule: Schedule) => void;
  /**
   * 正在生成的回答（流式）。`text` 是到目前为止的全文；`reset` 表示刚才那段作废（见 `AnswerDraft`）。
   * 草稿不落库，错过了也没关系 —— 任务结束时 `task` 事件里有最终回答，以它为准。
   */
  draft: (draft: TaskDraft) => void;
  /** 模型目录变了（拉到了新的模型列表）。生效中的模型已经换好，宿主刷新界面即可。 */
  models: (catalogs: readonly VendorCatalog[]) => void;
  /** 画布有了新版本（Agent 改的或用户改的）。 */
  canvas: (version: CanvasVersion) => void;
}

/** 某个任务正在生成的回答。 */
export type TaskDraft = AnswerDraft & { readonly taskId: TaskId };

export interface MelonAgent extends Omit<AssembledAgent, 'schedules'> {
  /** 让 Agent 做一件事。返回刚创建的任务；进展通过 `on('task')` 或 `watch` 看。 */
  run(goal: string, opts?: RunOptions): Promise<Task>;
  /** 回应待确认的操作。不用传 callId —— 一个任务同一时刻只有一个待确认。 */
  approve(taskId: string, decision: ApprovalDecision): Promise<void>;
  on<E extends keyof AgentEvents>(event: E, cb: AgentEvents[E]): () => void;
  readonly tasks: {
    get(id: string): Promise<Task | null>;
    /** 默认全部状态、按创建时间，最多 200 条。 */
    list(opts?: { states?: readonly TaskState[]; limit?: number }): Promise<readonly Task[]>;
    /** 任务的完整事件流（重放用、调试面板用）。 */
    history(id: string): Promise<readonly Sequenced<TaskEvent>[]>;
  };
  readonly schedules: Schedules;
  readonly models: {
    /** 至少有一个可用模型。 */
    readonly ready: boolean;
    readonly entries: readonly ModelEntry[];
    /** 用一次最便宜的调用验证模型可用（key、网络、模型名）。 */
    test(entry: ModelEntry): Promise<ModelTestResult>;
    /** 某类任务现在会选哪个模型、为什么、预估每次多少钱。不发请求。 */
    explain(rule: RoutingRule, ctx?: RouteContext): RouteExplanation;
    /** 这个账号在这家能用哪些模型（`/models`）。宿主做「新发现的模型」。适配器不支持时返回 null。 */
    discover(entry: ModelEntry, signal?: AbortSignal): Promise<readonly string[] | null>;
    /** 模型目录：每家（`providers`）最新可用的模型、档次怎么定的、价格从哪来、参不参与路由。 */
    catalog(): readonly VendorCatalog[];
    /** 立即重新拉一家或全部的模型列表。生效中的模型随之更新。 */
    refresh(vendor?: string): Promise<readonly ModelListing[]>;
    /**
     * 账户出了问题的厂商（余额不足、key 失效）：这一家暂停使用（自动换别家），到期再试。
     * 宿主据此提示用户去充值或换 key。改了这家的配置、连接测试通过时立即恢复。
     */
    accounts(): readonly AccountProblem[];
  };
  readonly tools: ToolRegistry;
  /**
   * 「始终允许」过的操作。宿主做授权清单用：列出来给用户看，让用户能撤销。
   * `scope` 是人可读的范围（如 `to=a@b.com`，`*` 表示不限）。
   */
  /**
   * 画布：取当前内容、历史版本；用户在界面上改（`edit`，按格式校验，记成用户改的版本）、回到某个版本（`revert`，追加一个新版本）。
   */
  readonly canvas: {
    get(id: string): Promise<CanvasVersion | null>;
    history(id: string, limit?: number): Promise<readonly CanvasVersion[]>;
    /** 用户改：给整份新内容（`doc`）或一组修改（`ops`）。`base` 是用户改之前看到的版本 —— 期间 Agent 改过就冲突（返回 conflict）。 */
    edit(id: string, kind: string, change: { doc?: unknown; ops?: readonly PatchOp[]; note?: string; base?: number }): Promise<{ ok: true; version: CanvasVersion } | { ok: false; error: string; conflict?: boolean }>;
    revert(id: string, version: number): Promise<CanvasVersion | null>;
  };
  /**
   * 用户的长期记忆。宿主做「记忆」管理用：列出来给用户看，让用户删。
   * 删除是物理删除（privacy），并记审计。
   */
  readonly memories: {
    list(): Promise<readonly Memory[]>;
    forget(id: string): Promise<boolean>;
    /** 全部清除。返回删了几条。 */
    clear(): Promise<number>;
  };
  /** 价格同步：每家上次同步的结果、立即同步、确认 / 忽略变化很大的价格。 */
  readonly prices: {
    status(): readonly (PriceSync | { readonly vendor: string; readonly url: string; readonly never: true })[];
    sync(vendor?: string): Promise<readonly PriceSync[]>;
    confirm(vendor: string, model: string): Promise<boolean>;
    dismiss(vendor: string, model: string): Promise<boolean>;
  };
  /** 用量与费用。宿主做用量页、厂商状态用。 */
  readonly usage: {
    /** 时间范围内的汇总：总数、按小时 / 按天分格、按模型 / 厂商 / 任务类型 / 触发方式 / 用途分组。费用折成 `currency`（默认 CNY）。 */
    summary(o: Omit<SummaryOptions, 'fx'>): Promise<UsageSummary>;
    /** 原始记录（明细与汇总行），排查用。 */
    list(q: UsageQuery): Promise<readonly UsageRecord[]>;
  };
  readonly grants: {
    list(agentId?: string): Promise<readonly Grant[]>;
    /** 不传 scope 撤销这个工具的全部授权。 */
    revoke(toolId: string, scope?: string, agentId?: string): Promise<void>;
    /**
     * 用户在宿主的界面上直接给的「始终允许」（如「本地文件」里添加一个文件夹）。和确认卡上点「始终允许」一样记审计。
     * `toolId` 可以是工具 id，也可以是按单位授权的名下（`FILES_GRANT_KEY`）。
     */
    add(toolId: string, scope: string, agentId?: string): Promise<void>;
  };
  /** 运行中替换模型、工具、技能来源、执行权限 —— 不重启，在跑的任务不受影响。 */
  configure(patch: {
    models?: readonly ModelEntry[];
    strategy?: RouteStrategy;
    tools?: readonly Tool[];
    skills?: readonly SkillProvider[];
    policy?: PolicyMode | ((task: Task) => PolicyMode);
    /** 汇率、最多试几个模型。保留期只在创建时给。 */
    metering?: { fx?: FxRates; maxAttempts?: number };
    routing?: RoutingRules;
    /** 换价格来源（宿主按用户启用了哪几家决定）。 */
    pricing?: { sources: readonly PriceSource[] };
    /** 换跟随官方的厂商（及用户的改动）。连接配置变了的会在后台重新拉模型列表，拉完发 `models` 事件。 */
    providers?: readonly ModelProvider[];
    /** 换定制 Agent 的定义。 */
    agents?: readonly AgentProfile[];
    /** 换画布的种类。 */
    canvasKinds?: readonly CanvasKind[];
  }): Promise<void>;
  /** 底层调度器。一般用 `schedules` 就够了。 */
  readonly scheduler: Scheduler;
}

/** 字节 → base64。根入口不能用 Node 的 Buffer：分段转成二进制串再 btoa。 */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 画布内容直接放进上下文的上限（字）；再长的只给开头，Agent 用 canvas.read 读全。 */
const CANVAS_INLINE = 12_000;

/** 附件文字的 artifact 记在这个名下（任务还没创建；读的权限由 task.attachments 给）。 */
const ATTACHMENT_OWNER = 'attachments' as TaskId;

const ALL_STATES: readonly TaskState[] = [
  'PENDING', 'PLANNING', 'ADMITTING', 'EXECUTING', 'OBSERVING',
  'AWAITING_APPROVAL', 'SUSPENDED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
];
const TERMINAL = new Set<TaskState>(TERMINAL_STATES);

/**
 * 创建一个 Agent。**所有选项都有默认值**，最少只需要模型：
 *
 * ```ts
 * const agent = await createAgent({ models: [deepseek({ apiKey })] });
 * const task = await agent.run('汇总本周进展');
 * agent.on('task', (t) => render(t));
 * ```
 */
export async function createAgent(opts: AgentOptions = {}): Promise<MelonAgent> {
  const platform = opts.platform ?? defaultPlatform({ min: opts.logLevel ?? 'info' });
  const { logger } = platform;
  const stores: Storage = opts.storage ?? opts.stores ?? memoryStorage();
  const defaultAgent = opts.agentId ?? 'default';

  let metering = opts.metering ?? {};
  const pool = new ModelPool(opts.models ?? [], opts.strategy ?? 'balanced', {
    ledger: stores.usage,
    ...(metering.fx ? { fx: metering.fx } : {}),
    ...(metering.maxAttempts ? { maxAttempts: metering.maxAttempts } : {}),
    now: () => platform.clock.now(),
    onLedgerError: (e) => logger.log('warn', `用量记账失败：${e instanceof Error ? e.message : String(e)}`),
    ...(opts.spendGuard ? { guard: opts.spendGuard } : {}),
  });
  if (opts.routing) pool.route(opts.routing);
  // 价格簿：同步来的官方价格，选模型和记账都用它（手填的不覆盖）。第一次同步时和内置价格比
  const book = new PriceBook({
    store: stores.prices, now: () => platform.clock.now(),
    builtin: (vendor, model) => pool.current.entries.find((e) => e.egress === vendor && e.model.id === model && e.priceSource !== 'manual')?.price,
  });
  await book.load();
  book.setSources(opts.pricing?.sources ?? []);
  pool.pricing(book);
  // 模型目录：固定的条目（models）+ 跟随官方展开的（providers）一起交给路由
  let fixedModels: readonly ModelEntry[] = opts.models ?? [];
  const catalog = new ModelCatalog({ store: stores.catalog, now: () => platform.clock.now() });
  await catalog.load();
  let staleVendors = catalog.setProviders(opts.providers ?? []);
  const rebuild = (): void => {
    if (fixedModels.length === 0 && catalog.vendors.length === 0) { pool.set([]); return; }
    pool.set([...fixedModels, ...catalog.expand(book).entries]);
  };
  rebuild();
  const catalogEvery = (opts.catalog?.intervalHours ?? 24) * 3_600_000;
  const syncEvery = (opts.pricing?.intervalHours ?? 24) * 3_600_000;
  // 事件在下面才接上；价格同步完成时目录要通知宿主
  let emitModels = (): void => {};
  let started = false;
  // 到期的才同步；在后台跑，不拖慢启动，失败只记日志（价格照旧用上次的）
  const syncDue = (): void => {
    for (const s of book.status()) {
      if (book.age(s.vendor) < syncEvery) continue;
      book.sync(s.vendor).then(([r]) => {
        if (r && !r.ok) logger.log('warn', `价格同步失败（${r.vendor}）：${r.error}`);
        // 新上架的模型有了价格就进目录
        else if (catalog.vendors.includes(s.vendor)) { rebuild(); emitModels(); }
      }).catch((e) => logger.log('warn', `价格同步出错：${e instanceof Error ? e.message : String(e)}`));
    }
  };
  let priceTimer: ReturnType<typeof setInterval> | undefined;
  // 用账本预热：近一小时总出错的模型、近 7 天各类任务的典型用量（自动路由预估花费用）、近一个月的套餐用量（额度）
  const seedPool = async (): Promise<void> => {
    pool.stats.clear();
    pool.seed(await stores.usage.list({ from: platform.clock.now() - 31 * 86_400_000, to: platform.clock.now() + 1 }));
  };
  await seedPool();
  // 超过保留期的明细按天汇总：启动时一次，之后每天一次
  const retentionMs = (metering.retentionDays ?? 90) * 86_400_000;
  const rollup = async (): Promise<void> => {
    try { await stores.usage.rollup(platform.clock.now() - retentionMs); } catch (e) {
      logger.log('warn', `用量汇总失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  let rollupTimer: ReturnType<typeof setInterval> | undefined;
  const memoryOn = (): boolean => (typeof opts.memory === 'object' ? (opts.memory.enabled?.() ?? true) : !!opts.memory);
  // 内置技能总在最前：注册表按来源定先后，宿主和用户装的技能不能顶替它们
  const drafts = opts.scheduleDrafts;
  let canvasKinds = new Map((opts.canvasKinds ?? []).map((k) => [k.kind, k]));
  const validator = opts.validator ?? basicValidator;
  const builtins: SkillProvider[] = [
    artifact(),
    canvas({
      store: stores.canvases, kinds: () => canvasKinds, validator, now: platform.clock.now,
      canvasOf: async (id) => (await stores.tasks.get(id))?.canvas ?? null,
      onChange: (v) => emit('canvas', v),
    }),
    ...(opts.memory ? [memory({
      store: stores.memories, purger: stores.purger, ids: platform.ids, now: platform.clock.now,
      enabled: () => memoryOn(),
    })] : []),
    ...(drafts ? [schedule({
      check: (when) => {
        if (when.repeat === 'now') return { ok: true as const };
        const r = whenToRule(when as When, { now: platform.clock.now() });
        return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
      },
      ...(typeof drafts === 'object' && drafts.when ? { when: drafts.when } : {}),
    })] : []),
  ];
  const registry = new ToolRegistry({ tools: opts.tools ?? [], providers: [...builtins, ...(opts.skills ?? [])], now: platform.clock.now });
  let profiles = new Map((opts.agents ?? []).map((p) => [p.id, p]));
  registry.setAgents(opts.agents ?? []);
  await registry.ready();

  let policy = opts.policy ?? 'low-risk-auto';
  const policyMode = (task: Task): PolicyMode => (typeof policy === 'function' ? policy(task) : policy);

  const planner = opts.planner ?? new ReActPlanner({
    router: pool,
    classifier: new KeywordIntentClassifier(),
    ids: platform.ids,
    hash: (x) => platform.hasher.sha256(x).slice(0, 16),
    ...(opts.actionWords?.length ? { actionWords: [...DEFAULT_ACTION_WORDS, ...opts.actionWords] } : {}),
    // 定制 Agent 可以关思考（写作类的不需要推理，思考只是又慢又贵）
    thinkingOf: (task) => profiles.get(String(task.agentId))?.thinking,
  });

  // ── 事件：宿主不必自己给每个任务挂 watch ──
  const listeners = {
    task: new Set<AgentEvents['task']>(), schedule: new Set<AgentEvents['schedule']>(), draft: new Set<AgentEvents['draft']>(),
    models: new Set<AgentEvents['models']>(), canvas: new Set<AgentEvents['canvas']>(),
  };
  const emit = <E extends keyof AgentEvents>(event: E, value: Parameters<AgentEvents[E]>[0]): void => {
    for (const cb of listeners[event]) {
      try { (cb as (v: typeof value) => void)(value); } catch (e) {
        logger.log('error', `${event} 监听器抛错`, { error: String(e) });
      }
    }
  };
  const following = new Set<string>();
  let stopping = false;
  emitModels = () => { if (listeners.models.size > 0) emit('models', catalog.expand(book).catalogs); };
  // 拉模型列表：在后台跑，失败只记日志（用上次的列表）
  const refreshCatalog = async (vendor?: string): Promise<readonly ModelListing[]> => {
    const out = await catalog.refresh(vendor);
    for (const r of out) if (!r.ok) logger.log('warn', `模型列表获取失败（${r.vendor}）：${r.error}`);
    rebuild();
    emitModels();
    return out;
  };
  const refreshInBackground = (vendors: readonly string[]): void => {
    for (const v of vendors) {
      refreshCatalog(v).catch((e) => logger.log('warn', `模型列表获取出错：${e instanceof Error ? e.message : String(e)}`));
    }
  };
  const catalogDue = (): void => {
    refreshInBackground(catalog.vendors.filter((v) => staleVendors.includes(v) || catalog.age(v) >= catalogEvery));
    staleVendors = [];
  };

  // ── 上下文预算：任何宿主的上下文装配之后都过一遍（宿主不用自己算长度）──
  const rawContext = opts.memory
    ? withMemory(opts.buildContext ?? opts.context ?? basicContext(stores.episodes), stores.memories, memoryOn)
    : opts.buildContext ?? opts.context ?? basicContext(stores.episodes);
  const budget = opts.contextBudget === false ? null : (opts.contextBudget ?? 24_000);
  const tokenizer = new HeuristicTokenizer();
  // 同一段旧内容每一步都在：摘要按输入缓存，不每步重摘
  const summaries = new Map<string, Promise<string>>();
  const summarizeFor = (task: Task) => (text: string, kind: 'history' | 'steps'): Promise<string> => {
    const key = `${kind}\u0000${text}`;
    const hit = summaries.get(key);
    if (hit) return hit;
    const p = (async () => {
      const meta = { taskId: task.id, agentId: task.agentId, taskKind: task.kind, trigger: task.trigger.type, purpose: 'compact' };
      const d = await pool.select('compact', undefined, { needsTools: false, meta });
      const r = await d.primary.generate({
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: `${kind === 'history' ? '之前的对话' : '之前的步骤'}：\n${text}` },
        ],
        maxOutputTokens: 800, meta,
      });
      return r.text;
    })();
    p.catch(() => summaries.delete(key));
    summaries.set(key, p);
    if (summaries.size > 200) summaries.delete(summaries.keys().next().value as string);
    return p;
  };
  // 图片：装配器只写句柄，发给模型前读出内容（base64）。同一张图每一步都在，读过的留着（最多 16 张）
  const imageData = new Map<string, Promise<string>>();
  const withImages = async (bundle: ContextBundle): Promise<ContextBundle> => {
    if (!bundle.messages.some((m) => m.images?.length)) return bundle;
    const messages = await Promise.all(bundle.messages.map(async (m) => {
      if (!m.images?.length) return m;
      const images = await Promise.all(m.images.map(async (i) => {
        if (i.data) return i;
        let p = imageData.get(i.ref);
        if (!p) {
          p = stores.artifacts.read(i.ref).then(toBase64);
          p.catch(() => imageData.delete(i.ref));
          imageData.set(i.ref, p);
          if (imageData.size > 16) imageData.delete(imageData.keys().next().value as string);
        }
        try { return { ...i, data: await p }; } catch { return i; }
      }));
      return { ...m, images };
    }));
    return { ...bundle, messages };
  };
  // 定制 Agent 的说明书：放在最前面（宿主的说明之前），不压缩
  const withProfile = (task: Task, bundle: ContextBundle): ContextBundle => {
    const p = profiles.get(String(task.agentId));
    if (!p?.instructions?.trim()) return bundle;
    return { ...bundle, messages: [{ role: 'user', from: 'host', content: `【你是「${p.name}」】\n${p.instructions.trim()}` }, ...bundle.messages] };
  };
  // 绑定了画布：这种画布的写法、当前内容、用户上次之后在界面上改了哪里。放在前面（说明书之后）：
  // 放最后会压在刚返回的工具结果后面，模型就不知道该接着处理工具结果了。每一步都重新取，所以总是最新的
  const withCanvas = async (task: Task, bundle: ContextBundle): Promise<ContextBundle> => {
    if (!task.canvas) return bundle;
    const kind = canvasKinds.get(task.canvas.kind);
    if (!kind) return bundle;
    const rows = await stores.canvases.history(task.canvas.id, 50);
    const cur = rows[0] ?? null;
    let text = `【画布：${kind.name}】\n${kind.instructions.trim()}\n\n`;
    if (!cur) text += '画布现在是空的。第一次生成用 canvas.update：[{ op: "replace", path: "", value: 完整内容 }]。';
    else {
      const json = JSON.stringify(cur.doc);
      text += `当前内容 v${cur.version}${json.length > CANVAS_INLINE ? `（太长，只给开头，要改的地方用 canvas.read 读全）` : ''}：\n${json.slice(0, CANVAS_INLINE)}`;
      // 用户在界面上改的：从最新往回数到 Agent 的上一版
      const edits: CanvasVersion[] = [];
      for (const r of rows) { if (r.by !== 'user') break; edits.push(r); }
      if (edits.length) {
        const before = rows[edits.length];
        const notes = edits.reverse().map((e) => e.note).filter(Boolean);
        const paths = before ? diffPaths(before.doc, cur.doc) : [];
        text += `\n\n用户在界面上改过（以用户改的为准，不要改回去）：${notes.length ? notes.join('；') : ''}${paths.length ? `${notes.length ? '；' : ''}改动位置 ${paths.join('、')}` : ''}`;
      }
    }
    return { ...bundle, messages: [{ role: 'user', from: 'host', content: text }, ...bundle.messages] };
  };
  const rawWithExtras = async (task: Task) => withProfile(task, await withCanvas(task, await rawContext(task)));
  const buildContext = budget === null ? async (task: Task) => withImages(await rawWithExtras(task)) : async (task: Task): Promise<ContextBundle> => {
    const ctx = await rawWithExtras(task);
    const { bundle, report } = await fitContext(ctx, { budget, tokenizer, summarize: summarizeFor(task) });
    if (report.actions.length) logger.log('info', '上下文超出预算，已压缩', { taskId: task.id, before: report.before, after: report.after, actions: report.actions.join(',') });
    return withImages(bundle);
  };

  const base = await assemble({
    stores,
    planner,
    resolver: opts.resolver ?? registry,
    validator,
    platform,
    policy: policyMode,
    buildContext,
    availableTools: opts.availableTools ?? (async (task) => registry.modelTools(task)),
    toolset: opts.toolset ?? (() => registry.toolset()),
    ...(opts.retention ? { retention: opts.retention } : {}),
    ...(opts.quotaOf ? { quotaOf: opts.quotaOf } : {}),
    ...(opts.spendGuard ? { spendGuard: opts.spendGuard } : {}),
    ...(opts.execute ? { execute: opts.execute } : {}),
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    ...(opts.schedulePollMs !== undefined ? { schedulePollMs: opts.schedulePollMs } : {}),
    // 草稿只是显示用的，没人听就不发
    onDraft: (taskId, d) => { if (listeners.draft.size > 0) emit('draft', { ...d, taskId }); },
    ...(opts.recallSkills ? { recallSkills: opts.recallSkills } : {}),
    onSubmitted: (task) => {
      follow(task.id);
      // 定时触发出来的任务：顺带通知那条定时任务（它的触发次数、下次时间变了）
      if (task.trigger.type === 'schedule' && task.trigger.ref) void emitSchedule(task.trigger.ref);
      opts.onSubmitted?.(task);
    },
  });

  /**
   * 跟住一个任务直到它结束，每个事件之后报一次最新状态。
   * 用 watch 而不是直接订阅事件：watch 在事务提交之后才吐事件，报出去的任务不会比事件旧。
   */
  function follow(id: string): void {
    if (following.has(id)) return;
    following.add(id);
    void (async () => {
      try {
        for await (const _e of base.watch(id as TaskId)) await report(id);
      } catch (e) {
        // 停机时存储先关，还在等人的任务的 watch 会在下一次轮询时抛错 —— 正常收尾
        if (!stopping) logger.log('error', '任务跟踪中断', { taskId: id, error: String(e) });
      } finally {
        following.delete(id);
        if (!stopping) await report(id);
      }
    })();
  }
  async function report(id: string): Promise<void> {
    const t = await base.get(id as TaskId).catch(() => null);
    if (t) emit('task', t);
  }
  async function emitSchedule(id: string): Promise<void> {
    const s = await base.schedules.get(asScheduleId(id)).catch(() => null);
    if (s) emit('schedule', s);
  }

  /** 用户在宿主界面上删记忆：物理删除，每条记一笔审计（谁、什么时候删的）。 */
  async function forgetMemories(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await stores.purger.purge({
      refs: ids.map((ref) => ({ kind: 'memory', ref })), motive: 'privacy', reason: '用户在记忆管理里删除',
    });
    const traceId = platform.tracer.root().traceId;
    for (const t of res.tombstones) {
      await base.audit.record({
        at: platform.clock.now(), actor: { kind: 'user', id: 'user' }, action: 'memory.write',
        resource: { kind: 'memory', ref: t.ref }, outcome: 'ok', traceId,
        dimensions: { change: 'forget', by: 'user' }, basis: { motive: 'privacy' },
      });
    }
    return res.tombstones.length;
  }

  const schedules: Schedules = {
    async create(input) {
      let s: Schedule;
      if ('when' in input) {
        const built = whenToRule(input.when, { now: platform.clock.now() });
        if (!built.ok) throw new Error(built.error);
        s = await base.schedules.create({
          title: input.title ?? '',
          template: { agentId: asAgentId(input.agentId ?? defaultAgent), kind: input.kind ?? 'automation', goal: input.goal },
          rule: built.rule,
          catchUp: input.catchUp ?? 'skip',
        });
      } else {
        s = await base.schedules.create(input);
      }
      emit('schedule', s);
      return s;
    },
    async update(id, patch) {
      const s = await base.schedules.update(asScheduleId(id), patch);
      emit('schedule', s);
      return s;
    },
    async pause(id) {
      const s = await base.schedules.setStatus(asScheduleId(id), 'paused');
      emit('schedule', s);
      return s;
    },
    async resume(id) {
      const s = await base.schedules.resume(asScheduleId(id));
      emit('schedule', s);
      return s;
    },
    async remove(id) {
      const s = await base.schedules.setStatus(asScheduleId(id), 'removed');
      emit('schedule', s);
      return s;
    },
    get: (id) => base.schedules.get(asScheduleId(id) as ScheduleId),
    list: (status) => base.schedules.list(undefined, status),
    describe: (s) => describeRule(s.rule),
    tick: () => base.schedules.tick(),
  };

  const agent: MelonAgent = {
    ...base,
    scheduler: base.schedules,
    schedules,
    tools: registry,
    async run(goal, o = {}) {
      // 新附件的文字存成 artifact（任务通过 task.attachments 读，不受「只能读本任务的」限制）；沿用的原样带上
      const attachments: Attachment[] = [];
      for (const a of o.attachments ?? []) {
        if ('textRef' in a) { attachments.push({ ...a, fresh: false }); continue; }
        if (a.image) {
          const textRef = await stores.artifacts.put(ATTACHMENT_OWNER, a.image.data, { mime: a.image.mime, summary: `图片：${a.name}` });
          attachments.push({ name: a.name, size: a.size, note: a.note, textRef, chars: 0, fresh: true, image: { mime: a.image.mime } });
          continue;
        }
        const text = a.text ?? '';
        const textRef = await stores.artifacts.put(ATTACHMENT_OWNER, text, { mime: 'text/plain', summary: `附件：${a.name}` });
        attachments.push({ name: a.name, size: a.size, note: a.note, textRef, chars: text.length, fresh: true, head: text.slice(0, 3000) });
      }
      return base.submit({
        agentId: asAgentId(o.agentId ?? defaultAgent),
        kind: o.kind ?? 'conversation',
        goal,
        trigger: o.ref !== undefined ? { type: 'manual', ref: o.ref } : { type: 'manual' },
        ...(o.budget ? { budget: o.budget } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(o.canvas ? { canvas: o.canvas } : {}),
        ...(o.tools === false ? { toolsOff: true } : {}),
        ...(o.thinking ? { thinking: o.thinking } : {}),
      });
    },
    async approve(taskId, decision) {
      const t = await base.get(taskId as TaskId);
      if (!t?.pendingCall) throw new Error(`任务 ${taskId} 没有在等确认`);
      await base.resolveApproval(taskId as TaskId, t.pendingCall.callId, decision);
    },
    on(event, cb) {
      (listeners[event] as Set<typeof cb>).add(cb);
      return () => { (listeners[event] as Set<typeof cb>).delete(cb); };
    },
    tasks: {
      get: (id) => base.get(id as TaskId),
      list: (o = {}) => stores.tasks.listByState(o.states ?? ALL_STATES, o.limit ?? 200),
      async history(id) {
        const rows: Sequenced<TaskEvent>[] = [];
        for await (const r of stores.events.read(id as TaskId)) rows.push(r);
        return rows;
      },
    },
    canvas: {
      get: (id) => stores.canvases.latest(id),
      history: (id, limit) => stores.canvases.history(id, limit),
      async edit(id, kind, change) {
        const k = canvasKinds.get(kind);
        if (!k) return { ok: false, error: `不认识的画布类型：${kind}` };
        const cur = await stores.canvases.latest(id);
        if (change.base !== undefined && (cur?.version ?? 0) !== change.base) {
          return { ok: false, conflict: true, error: `画布已经更新到 v${cur?.version ?? 0}（你改的是 v${change.base}）` };
        }
        let doc: unknown;
        try { doc = change.ops ? applyPatch(cur?.doc ?? null, change.ops) : change.doc; } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        const issues = validator.validate(k.schema, doc);
        if (issues.length) return { ok: false, error: issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('；') };
        const v: CanvasVersion = {
          canvasId: id, kind, version: (cur?.version ?? 0) + 1, doc, by: 'user', at: platform.clock.now(),
          ...(change.note ? { note: String(change.note).slice(0, 200) } : {}),
        };
        try { await stores.canvases.append(v); } catch (e) {
          return { ok: false, conflict: true, error: e instanceof Error ? e.message : String(e) };
        }
        emit('canvas', v);
        return { ok: true, version: v };
      },
      async revert(id, version) {
        const old = await stores.canvases.get(id, version);
        const cur = await stores.canvases.latest(id);
        if (!old || !cur) return null;
        const v: CanvasVersion = { canvasId: id, kind: cur.kind, version: cur.version + 1, doc: old.doc, by: 'user', at: platform.clock.now(), note: `回到 v${version}` };
        await stores.canvases.append(v);
        emit('canvas', v);
        return v;
      },
    },
    memories: {
      list: () => activeMemories(stores.memories, 500),
      forget: async (id) => (await forgetMemories([id])) > 0,
      clear: async () => forgetMemories((await activeMemories(stores.memories, 10_000)).map((m) => m.id)),
    },
    // 价格变了，目录（哪些模型有官方价格、按价格定的档次）跟着变
    prices: {
      status: () => book.status(),
      sync: async (vendor) => { const r = await book.sync(vendor); rebuild(); return r; },
      confirm: async (vendor, model) => { const r = await book.confirm(vendor, model); rebuild(); return r; },
      dismiss: async (vendor, model) => { const r = await book.dismiss(vendor, model); rebuild(); return r; },
    },
    usage: {
      summary: async (o) => summarizeUsage(
        await stores.usage.list({ from: o.from, to: o.to }),
        { ...o, ...(metering.fx ? { fx: metering.fx } : {}) },
      ),
      list: (q) => stores.usage.list(q),
    },
    grants: {
      list: (id) => stores.grants.listByAgent(asAgentId(id ?? defaultAgent)),
      async add(toolId, scope, id) {
        const at = platform.clock.now();
        await stores.grants.put({ agentId: asAgentId(id ?? defaultAgent), toolId: asToolId(toolId), scope, grantedAt: at });
        await base.audit.record({
          at,
          actor: { kind: 'user', id: 'user' },
          action: 'policy.change',
          resource: { kind: 'grant', ref: toolId },
          outcome: 'ok',
          traceId: platform.tracer.root().traceId,
          dimensions: { toolId, change: 'grant' },
          basis: { change: 'grant', scope },
        });
      },
      async revoke(toolId, scope, id) {
        await stores.grants.revoke(asAgentId(id ?? defaultAgent), toolId, scope);
        // 授权的增删都要能追溯：授予在管线里记，撤销在这里记
        await base.audit.record({
          at: platform.clock.now(),
          actor: { kind: 'user', id: 'user' },
          action: 'policy.change',
          resource: { kind: 'grant', ref: toolId },
          outcome: 'ok',
          traceId: platform.tracer.root().traceId,
          dimensions: { toolId, change: 'revoke', all: scope === undefined },
          basis: { change: 'revoke', scope: scope ?? '*' },
        });
      },
    },
    models: {
      get ready() { return pool.ready; },
      get entries() { return pool.current.entries; },
      // 测试也顺带更新账户状态：通过了就恢复这一家，余额不足就标上（用户点「测试」时最想知道的就是这个）
      test: async (entry) => {
        const r = await testModel(entry);
        if (r.ok) pool.clearAccount(entry.egress);
        else {
          const kind = isAccountError(r.error ?? '');
          if (kind) pool.markAccount(entry.egress, kind, r.error ?? '');
        }
        return r;
      },
      accounts: () => pool.accounts(),
      explain: (rule, ctx) => pool.explain(rule, ctx),
      discover: async (entry, signal) => (entry.model.listModels ? entry.model.listModels(signal) : null),
      catalog: () => catalog.expand(book).catalogs,
      refresh: (vendor) => refreshCatalog(vendor),
    },
    async configure(patch) {
      if (patch.strategy !== undefined) pool.set(pool.current.entries, patch.strategy);
      if (patch.models !== undefined) fixedModels = patch.models;
      if (patch.providers !== undefined) {
        const changed = catalog.setProviders(patch.providers);
        staleVendors = [...new Set([...staleVendors, ...changed])];
        // 换了 key、改了配置的厂商：之前记的余额不足 / key 失效不作数了，重新试
        for (const v of changed) pool.clearAccount(v);
      }
      if (patch.models !== undefined || patch.providers !== undefined) rebuild();
      // 换了 key、新启用的厂商：后台去拉它的模型列表（启动前配置的，等 start 时再拉）
      if (patch.providers !== undefined && started) catalogDue();
      if (patch.tools !== undefined) registry.setTools(patch.tools);
      if (patch.canvasKinds !== undefined) canvasKinds = new Map(patch.canvasKinds.map((k) => [k.kind, k]));
      if (patch.agents !== undefined) { profiles = new Map(patch.agents.map((p) => [p.id, p])); registry.setAgents(patch.agents); }
      // 换技能来源时内置的保留 —— 宿主只管自己那一份
      if (patch.skills !== undefined) await registry.setProviders([...builtins, ...patch.skills]);
      if (patch.policy !== undefined) policy = patch.policy;
      if (patch.pricing) {
        book.setSources(patch.pricing.sources);
        if (!stopping) syncDue();
      }
      if (patch.routing) {
        pool.route(patch.routing);
        // 任务类别的分法可能变了：统计按新规则重新归类
        await seedPool();
      }
      if (patch.metering) {
        metering = { ...metering, ...patch.metering };
        pool.meter({
          ...(patch.metering.fx ? { fx: patch.metering.fx } : {}),
          ...(patch.metering.maxAttempts ? { maxAttempts: patch.metering.maxAttempts } : {}),
        });
      }
    },
    async start() {
      stopping = false;
      await base.start();
      await rollup();
      rollupTimer ??= setInterval(() => void rollup(), 86_400_000);
      // 不拖住进程退出（CLI 宿主跑完就该退）
      (rollupTimer as { unref?: () => void }).unref?.();
      // 价格、模型列表：启动时把到期的拉了，之后每小时看一次有没有到期的
      started = true;
      syncDue();
      catalogDue();
      priceTimer ??= setInterval(() => { syncDue(); catalogDue(); }, 3_600_000);
      (priceTimer as { unref?: () => void }).unref?.();
      // 重启后接着跟住没结束的任务 —— 宿主的界面要继续动
      for (const t of await stores.tasks.listByState(ALL_STATES.filter((s) => !TERMINAL.has(s)), 1000)) follow(t.id);
    },
    async stop() {
      stopping = true;
      started = false;
      if (rollupTimer) { clearInterval(rollupTimer); rollupTimer = undefined; }
      if (priceTimer) { clearInterval(priceTimer); priceTimer = undefined; }
      await base.stop();
    },
  };

  if (opts.start !== false) await agent.start();
  return agent;
}
