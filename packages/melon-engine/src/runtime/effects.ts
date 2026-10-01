import type {
  AnswerDraft, AuditRecorder, ContextBundle, Effect, EpisodeStore, IdGen, Logger, ModelTool, Planner, PolicyMode, Task,
  TaskEvent, TaskSpec, TaskStore, ToolCall, Tracer,
} from '@melon-ai/core';
import type { ToolPipeline } from '@melon-ai/skills';

/** effect 执行产生的后续事件，交回 apply 循环。 */
export interface Follow {
  readonly taskId: Task['id'];
  readonly events: readonly TaskEvent[];
}

export interface EffectDeps {
  readonly pipeline: ToolPipeline;
  readonly planner: Planner;
  readonly tasks: TaskStore;
  readonly episodes: EpisodeStore;
  readonly ids: IdGen;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly now: () => number;
  readonly policyMode: (task: Task) => PolicyMode;
  /** 组装上下文。默认 `basicContext`；带压缩的实现等 memory。 */
  readonly buildContext: (task: Task) => Promise<ContextBundle>;
  /** 本轮可用的工具，带全量 schema —— 供应商原生 tool use 需要。 */
  readonly availableTools: (task: Task) => Promise<readonly ModelTool[]>;
  /** 召回技能。P0 可以是空实现。 */
  readonly recallSkills?: (task: Task, query: string) => Promise<readonly string[]>;
  /** 创建子任务。由 engine 注入，避免 EffectRunner 反向依赖 engine。 */
  readonly createChild: (parentId: Task['id'], spec: TaskSpec) => Promise<Task>;
  readonly scheduleWake: (taskId: Task['id'], at: number) => void;
  /**
   * 审计。记「数据去向」（每次问模型，上下文发给了哪家）与用户的审批决定 ——
   * 这两样都不经过工具管线，管线的审计管不到。不传就不记（测试）。
   */
  readonly audit?: AuditRecorder;
  /** 回答草稿（流式）交给宿主。不进事件日志；不传就不流式。 */
  readonly onDraft?: (taskId: Task['id'], d: AnswerDraft) => void;
}

/**
 * 执行一个 I/O 型 effect，返回它产生的后续事件。
 *
 * **每个分支都必须幂等**（§2.3）：崩溃恢复靠 `resumeEffects` 重发同一个 effect，
 * 重发不能造成重复的外部后果。做不到幂等的（发邮件）靠管线的 IdempotencyStore 兜。
 */
export async function runEffect(deps: EffectDeps, effect: Effect): Promise<readonly Follow[]> {
  switch (effect.k) {
    case 'CallPlanner': {
      const task = await load(deps, effect.taskId);
      const span = deps.tracer.startSpan('plan', 'step', task.trace);
      try {
        const [context, availableTools] = await Promise.all([
          deps.buildContext(task),
          deps.availableTools(task),
        ]);
        const ctl = new AbortController();
        const step = await deps.planner.plan(
          {
            task, context, availableTools, trace: deps.tracer.child(task.trace),
            ...(deps.onDraft ? { draft: (d: AnswerDraft) => deps.onDraft!(task.id, d) } : {}),
          },
          ctl.signal,
        );
        span.end({ ok: true });
        // 数据去向：这一轮的上下文（任务目标、对话、工具结果）发给了哪家。守卫直接给出的步骤没问模型，不记
        if (deps.audit && step.via?.modelId) {
          await deps.audit.record({
            at: deps.now(),
            actor: { kind: 'system', id: 'planner' },
            action: 'model.route',
            resource: { kind: 'model-call', ref: task.id },
            outcome: 'ok',
            traceId: task.trace.traceId,
            spanId: task.trace.spanId,
            taskId: task.id,
            dimensions: {
              modelId: step.via.modelId, egress: step.via.egress ?? 'unknown',
              step: step.kind, inputTokens: context.totalTokens,
            },
            basis: { egress: step.via.egress ?? 'unknown' },
          });
        }
        return [{
          taskId: task.id,
          events: [{
            t: 'PlanProduced',
            step,
            ...(step.via?.promptRef ? { promptRef: step.via.promptRef } : {}),
            ...(step.via?.modelId ? { modelId: step.via.modelId } : {}),
            // 真实用量（规划器把这一步每次问模型的都加起来了）；拿不到时退回按上下文估的输入
            usage: step.via?.usage ?? { inputTokens: context.totalTokens, outputTokens: 0 },
          }],
        }];
      } catch (e) {
        span.end({ ok: false, errorCode: 'planner' });
        // 规划失败不该让任务悄悄卡住 —— 当成预算维度之外的失败直接收敛
        //
        // 日志必须带上原因：只打 taskId 的话，用户看到「规划失败」却无从下手，
        // 而这恰恰是接真模型后最常见的一类失败（鉴权、参数、限流）。
        const detail = e instanceof Error ? e.message : String(e);
        const code = (e as { code?: string })?.code;
        deps.logger.log('error', `规划失败：${detail}`, {
          taskId: effect.taskId,
          ...(code !== undefined ? { code } : {}),
        });
        return [{
          taskId: effect.taskId,
          events: [{
            t: 'Settled',
            outcome: { status: 'FAILED', reason: `规划失败：${e instanceof Error ? e.message : String(e)}` },
          }],
        }];
      }
    }

    case 'Admit': {
      const task = await load(deps, effect.taskId);
      const a = await deps.pipeline.admit(task, effect.call, deps.policyMode(task));
      const decision = a.kind === 'allow' ? 'allow' : a.kind === 'ask' ? 'ask' : 'deny';
      const events: TaskEvent[] = [{
        t: 'AdmissionResolved',
        callId: effect.call.callId,
        decision,
        reason: a.admission.reason,
        risk: a.risk,
        basis: a.admission.basis,
      }];
      return [{ taskId: task.id, events }];
    }

    case 'AskUser': {
      // 只记录。真正的等待由 AWAITING_APPROVAL 状态承担，可以等数小时
      return [{ taskId: effect.taskId, events: [{ t: 'ApprovalRequested', request: effect.request }] }];
    }

    case 'Grant': {
      // 记不下授权不该拦住这一次 —— 用户已经批准了；最多下次再问一遍
      try {
        const task = await load(deps, effect.taskId);
        const g = await deps.pipeline.grant(task, effect.call);
        if (!g) deps.logger.log('warn', '这个操作不能始终允许，只放行这一次', { taskId: task.id, toolId: effect.call.toolId });
      } catch (e) {
        deps.logger.log('error', `记录「始终允许」失败：${e instanceof Error ? e.message : String(e)}`, { taskId: effect.taskId });
      }
      return [];
    }

    case 'InvokeTool': {
      const task = await load(deps, effect.taskId);
      const result = await deps.pipeline.execute(task, effect.call);
      // artifactRef 必须一起进 L2：只写 summary 的话，大结果的句柄就丢了，
      // 模型看到「读取到 3 条」却没有任何办法拿到那 3 条的内容
      await appendEntry(deps, task, 'observation', result.summary, result.artifactRef);
      // ToolCallFinished 与 Observed 一起提交：否则崩在两者之间会把结果丢掉，
      // 而且会让 OBSERVING 变成静止状态，破坏 resumeEffects 的前提
      return [{
        taskId: task.id,
        events: [
          { t: 'ToolCallStarted', call: effect.call },
          { t: 'ToolCallFinished', callId: effect.call.callId, meta: {
            ok: result.ok, metrics: result.metrics,
            ...(result.error ? { errorCode: result.error.code } : {}),
            ...(result.error?.sandbox ? { sandbox: result.error.sandbox } : {}),
            ...(result.files?.length ? { files: result.files } : {}),
            ...(result.changes?.length ? { changes: result.changes } : {}),
            ...(result.artifactRef ? { artifactRef: result.artifactRef } : {}),
            ...(result.untrusted ? { untrusted: true } : {}),
          } },
          { t: 'Observed', callId: effect.call.callId, summary: result.summary,
            ...(result.artifactRef ? { artifactRef: result.artifactRef } : {}) },
        ],
      }];
    }

    case 'RecallSkills': {
      const skillIds = deps.recallSkills
        ? await deps.recallSkills(await load(deps, effect.taskId), effect.query)
        : [];
      return [{ taskId: effect.taskId, events: [{ t: 'SkillsInjected', skillIds }] }];
    }

    case 'SpawnChildren': {
      const events: TaskEvent[] = [];
      for (const spec of effect.specs) {
        const child = await deps.createChild(effect.parentId, spec);
        events.push({ t: 'ChildSpawned', childId: child.id });
      }
      return [{ taskId: effect.parentId, events }];
    }

    case 'NotifyParent':
      return [{
        taskId: effect.parentId,
        events: [{ t: 'ChildSettled', childId: effect.childId, outcome: effect.outcome }],
      }];

    case 'ScheduleWake':
      deps.scheduleWake(effect.taskId, effect.at);
      return [];

    case 'Compact':
    case 'PromoteMemory':
      // P0 先只关闭 episode。压缩与记忆提升等 memory（待建）
      if (effect.k === 'Compact') await deps.episodes.close(effect.episodeId, deps.now());
      deps.logger.log('debug', `${effect.k} 暂未实现，已跳过`, { taskId: effect.taskId });
      return [];

    case 'Emit':
      // Emit 应当已被 apply 循环吸收进事务，走到这里说明有人绕过了 apply
      throw new Error('Emit effect 不应到达 EffectRunner —— 它必须在 apply 的事务内被吸收');
  }
}

async function load(deps: EffectDeps, id: Task['id']): Promise<Task> {
  const t = await deps.tasks.get(id);
  if (!t) throw new Error(`任务不存在：${id}`);
  return t;
}

async function appendEntry(
  deps: EffectDeps, task: Task, kind: 'observation' | 'assistant', text: string,
  artifactRef?: string,
): Promise<void> {
  await deps.episodes.append(task.episodeId, {
    kind, text, at: deps.now(),
    ...(artifactRef !== undefined ? { artifactRef: artifactRef as never } : {}),
  });
}

export function pickCall(task: Task): ToolCall | undefined { return task.pendingCall; }
