import type {
  AgentId, ApprovalDecision, AuditSink, Grant, Budget, ContextBundle, IdempotencyStore, LogLevel, ModelEntry,
  ModelTool, Planner, Platform, PolicyMode, QuotaSnapshot, RetentionPolicy, Schedule, ScheduleId,
  ScheduleStatus, SchemaValidator, Sequenced, SkillProvider, StoreBundle, Task, TaskEvent, TaskId,
  TaskKind, TaskState, ToolResolver, ToolsetSnapshot,
} from '@melon-ai/core';
import { TERMINAL_STATES, asAgentId, asScheduleId } from '@melon-ai/core';
import { describeRule, whenToRule } from '@melon-ai/engine';
import type { CreateScheduleInput, Scheduler, UpdateScheduleInput, When } from '@melon-ai/engine';
import { DEFAULT_ACTION_WORDS, KeywordIntentClassifier, ModelPool, ReActPlanner, testModel } from '@melon-ai/llm';
import type { ModelTestResult, RouteStrategy } from '@melon-ai/llm';
import { ToolRegistry, artifact, basicValidator, schedule } from '@melon-ai/skills';
import type { Tool } from '@melon-ai/skills';
import { memoryStorage } from '@melon-ai/store';
import { assemble } from './assemble.js';
import type { AssembledAgent } from './assemble.js';
import { basicContext } from './context.js';
import { defaultPlatform } from './platform.js';

/** 存储：全套端口 + 审计 sink（+ 可选的幂等表）。`memoryStorage()` 与 `sqlite()` 都满足。 */
export type Storage = StoreBundle & { readonly audit: AuditSink; readonly idempotency?: IdempotencyStore };

export interface AgentOptions {
  /** 可用的模型。多个时按 `strategy` 路由。例：`[deepseek({ apiKey }), claude({ apiKey })]` */
  readonly models?: readonly ModelEntry[];
  /** 多模型时的路由策略。默认 balanced。 */
  readonly strategy?: RouteStrategy;
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
   * 让 Agent 可以拟定时任务草稿（内置工具 `schedule.propose`）。默认关 ——
   * 草稿要宿主画成卡片给用户确认，不支持的宿主开了，模型会以为草稿已经给用户看了。
   * 传 `{ when }` 可以收窄到某些任务（比如只在对话里）；默认是「不是定时触发的任务」。
   */
  readonly scheduleDrafts?: boolean | { readonly when?: (task: Task) => boolean };
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
}

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
  };
  readonly tools: ToolRegistry;
  /**
   * 「始终允许」过的操作。宿主做授权清单用：列出来给用户看，让用户能撤销。
   * `scope` 是人可读的范围（如 `to=a@b.com`，`*` 表示不限）。
   */
  readonly grants: {
    list(agentId?: string): Promise<readonly Grant[]>;
    /** 不传 scope 撤销这个工具的全部授权。 */
    revoke(toolId: string, scope?: string, agentId?: string): Promise<void>;
  };
  /** 运行中替换模型、工具、技能来源、执行权限 —— 不重启，在跑的任务不受影响。 */
  configure(patch: {
    models?: readonly ModelEntry[];
    strategy?: RouteStrategy;
    tools?: readonly Tool[];
    skills?: readonly SkillProvider[];
    policy?: PolicyMode | ((task: Task) => PolicyMode);
  }): Promise<void>;
  /** 底层调度器。一般用 `schedules` 就够了。 */
  readonly scheduler: Scheduler;
}

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

  const pool = new ModelPool(opts.models ?? [], opts.strategy ?? 'balanced');
  // 内置技能总在最前：注册表按来源定先后，宿主和用户装的技能不能顶替它们
  const drafts = opts.scheduleDrafts;
  const builtins: SkillProvider[] = [
    artifact(),
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
  await registry.ready();

  let policy = opts.policy ?? 'low-risk-auto';
  const policyMode = (task: Task): PolicyMode => (typeof policy === 'function' ? policy(task) : policy);

  const planner = opts.planner ?? new ReActPlanner({
    router: pool,
    classifier: new KeywordIntentClassifier(),
    ids: platform.ids,
    hash: (x) => platform.hasher.sha256(x).slice(0, 16),
    ...(opts.actionWords?.length ? { actionWords: [...DEFAULT_ACTION_WORDS, ...opts.actionWords] } : {}),
  });

  // ── 事件：宿主不必自己给每个任务挂 watch ──
  const listeners = { task: new Set<AgentEvents['task']>(), schedule: new Set<AgentEvents['schedule']>() };
  const emit = <E extends keyof AgentEvents>(event: E, value: Parameters<AgentEvents[E]>[0]): void => {
    for (const cb of listeners[event]) {
      try { (cb as (v: typeof value) => void)(value); } catch (e) {
        logger.log('error', `${event} 监听器抛错`, { error: String(e) });
      }
    }
  };
  const following = new Set<string>();
  let stopping = false;

  const base = await assemble({
    stores,
    planner,
    resolver: opts.resolver ?? registry,
    validator: opts.validator ?? basicValidator,
    platform,
    policy: policyMode,
    buildContext: opts.buildContext ?? opts.context ?? basicContext(stores.episodes),
    availableTools: opts.availableTools ?? (async (task) => registry.modelTools(task)),
    toolset: opts.toolset ?? (() => registry.toolset()),
    ...(opts.retention ? { retention: opts.retention } : {}),
    ...(opts.quotaOf ? { quotaOf: opts.quotaOf } : {}),
    ...(opts.execute ? { execute: opts.execute } : {}),
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    ...(opts.schedulePollMs !== undefined ? { schedulePollMs: opts.schedulePollMs } : {}),
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
    run(goal, o = {}) {
      return base.submit({
        agentId: asAgentId(o.agentId ?? defaultAgent),
        kind: o.kind ?? 'conversation',
        goal,
        trigger: o.ref !== undefined ? { type: 'manual', ref: o.ref } : { type: 'manual' },
        ...(o.budget ? { budget: o.budget } : {}),
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
    grants: {
      list: (id) => stores.grants.listByAgent(asAgentId(id ?? defaultAgent)),
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
      test: (entry) => testModel(entry),
    },
    async configure(patch) {
      if (patch.models !== undefined || patch.strategy !== undefined) {
        pool.set(patch.models ?? pool.current.entries, patch.strategy ?? pool.current.strategy);
      }
      if (patch.tools !== undefined) registry.setTools(patch.tools);
      // 换技能来源时内置的保留 —— 宿主只管自己那一份
      if (patch.skills !== undefined) await registry.setProviders([...builtins, ...patch.skills]);
      if (patch.policy !== undefined) policy = patch.policy;
    },
    async start() {
      stopping = false;
      await base.start();
      // 重启后接着跟住没结束的任务 —— 宿主的界面要继续动
      for (const t of await stores.tasks.listByState(ALL_STATES.filter((s) => !TERMINAL.has(s)), 1000)) follow(t.id);
    },
    async stop() {
      stopping = true;
      await base.stop();
    },
  };

  if (opts.start !== false) await agent.start();
  return agent;
}
