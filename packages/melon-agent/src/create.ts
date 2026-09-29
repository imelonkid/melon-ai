import type {
  AgentEngine, AgentId, AuditRecorder, AuditSink, ContextBundle, IdempotencyStore, ModelTool,
  Planner, Platform, PolicyMode, QuotaSnapshot, RetentionPolicy, SchemaValidator, StoreBundle,
  Task, ToolResolver, ToolsetSnapshot,
} from '@melon-ai/core';
import { ChainedRecorder, DEFAULT_RETENTION, assertRetention } from '@melon-ai/audit';
import { ToolPipeline } from '@melon-ai/tools';
import { Runtime } from '@melon-ai/runtime';
import { Scheduler } from '@melon-ai/trigger';

export interface CreateAgentOptions {
  /** 全套存储。换基础设施就是换这一个对象。 */
  readonly stores: StoreBundle & {
    readonly audit: AuditSink;
    readonly idempotency?: IdempotencyStore;
  };
  /** 可插拔的「大脑」。ReAct 只是其中一种实现。 */
  readonly planner: Planner;
  readonly resolver: ToolResolver;
  readonly validator: SchemaValidator;
  /** 时间、随机、日志、哈希、链路。见 `nodePlatform()`。 */
  readonly platform: Platform;

  /** 执行权限策略。可以按任务动态决定（例如不同 Agent 不同档位）。 */
  readonly policy?: PolicyMode | ((task: Task) => PolicyMode);
  readonly retention?: RetentionPolicy;
  readonly toolset?: () => ToolsetSnapshot;
  readonly quotaOf?: (agentId: AgentId) => Promise<QuotaSnapshot | null>;
  /** 上下文装配。P0 未提供时用最小实现，`@melon-ai/context` 就位后传真的。 */
  readonly buildContext?: (task: Task) => Promise<ContextBundle>;
  /** 本轮可用的工具，带全量 schema。默认空数组 —— 不给工具模型就只能直答。 */
  readonly availableTools?: (task: Task) => Promise<readonly ModelTool[]>;
  readonly recallSkills?: (task: Task, query: string) => Promise<readonly string[]>;
  readonly pollIntervalMs?: number;
  readonly execute?: { timeoutMs?: number; maxRetries?: number; backoffBaseMs?: number };
  /**
   * 定时任务的轮询间隔。默认 30s —— 到点后最晚 30s 触发。
   *
   * 不做成「精确到秒的定时器」是因为进程可能在两次触发之间被杀掉，
   * 精确定时器救不了这种情况，而轮询 + `nextFireAt` 落库天然能恢复。
   */
  readonly schedulePollMs?: number;
}

export interface MelonAgent extends AgentEngine {
  readonly audit: AuditRecorder & { verify(): Promise<unknown>; };
  readonly pipeline: ToolPipeline;
  /**
   * 定时任务。调度器不认识 AgentEngine —— 这里把 `submit` 注给它（§4.8 边界一），
   * 宿主拿到的是接好线的成品。
   */
  readonly schedules: Scheduler;
  readonly stores: CreateAgentOptions['stores'];
  /** 等所有在跑的推进链结束。测试与优雅关闭用。 */
  drain(): Promise<void>;
  recover(): Promise<number>;
}

/**
 * P0 的最小上下文。
 *
 * 只够让规划器跑起来 —— 没有预算分配、没有压缩、没有 L1 检索。
 * `@melon-ai/context` 就位后通过 `buildContext` 传入真实实现。
 */
const minimalContext = (window = 200_000): ContextBundle => ({
  messages: [], tools: [], slots: [], totalTokens: 0, window, watermark: 0.7,
});

const DEFAULT_TOOLSET: ToolsetSnapshot = { takenAt: 0, skills: [] };

/**
 * 组装一个 Agent。
 *
 * 这是**唯一允许 import 所有层的地方**（§2.1）—— 它的职责就是接线。
 * 宿主只依赖这一个包，换存储、换规划器、换模型都是换一个入参。
 */
export async function createAgent(opts: CreateAgentOptions): Promise<MelonAgent> {
  assertRetention(opts.retention ?? DEFAULT_RETENTION);

  const { clock, ids, logger, hasher, tracer } = opts.platform;
  const { stores } = opts;

  // 链尾必须从 sink 恢复，否则重启后会从 seq=1 重写、把审计链写断
  const audit = new ChainedRecorder({ sink: stores.audit, hasher, clock, logger });
  await audit.resume();

  const pipeline = new ToolPipeline({
    resolver: opts.resolver,
    validator: opts.validator,
    grants: stores.grants,
    artifacts: stores.artifacts,
    audit, clock, hasher, tracer, logger,
    ...(stores.idempotency ? { idempotency: stores.idempotency } : {}),
    ...(opts.quotaOf ? { quotaOf: opts.quotaOf } : {}),
    ...(opts.execute ? { execute: opts.execute } : {}),
  });

  const configured = opts.policy;
  const policyMode: (task: Task) => PolicyMode = typeof configured === 'function'
    ? configured
    : () => configured ?? 'ask';

  const runtime = new Runtime({
    tasks: stores.tasks,
    events: stores.events,
    episodes: stores.episodes,
    pipeline,
    planner: opts.planner,
    ids, tracer, logger,
    now: () => clock.now(),
    transaction: stores.transaction,
    policyMode,
    buildContext: opts.buildContext ?? (async () => minimalContext()),
    availableTools: opts.availableTools ?? (async () => []),
    ...(opts.recallSkills ? { recallSkills: opts.recallSkills } : {}),
    toolset: opts.toolset ?? ((): ToolsetSnapshot => DEFAULT_TOOLSET),
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
  });

  const schedules = new Scheduler({
    store: stores.schedules,
    submit: (spec) => runtime.submit(spec),
    clock, ids, logger,
  });

  return {
    submit: (spec) => runtime.submit(spec),
    get: (id) => runtime.get(id),
    cancel: (id, reason) => runtime.cancel(id, reason),
    resolveApproval: (id, callId, decision) => runtime.resolveApproval(id, callId, decision),
    watch: (id, fromSeq) => runtime.watch(id, fromSeq),
    start: async () => {
      await runtime.start();
      // 放在 runtime.start() 之后：崩溃恢复先跑完，再让定时器往里灌新任务
      schedules.start(opts.schedulePollMs ?? 30_000);
    },
    stop: async () => {
      schedules.stop();
      await runtime.stop();
    },
    drain: () => runtime.drain(),
    recover: () => runtime.recover(),
    audit,
    pipeline,
    schedules,
    stores,
  };
}
