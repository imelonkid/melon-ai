import type {
  AdmissionOutcome, AgentId, ApprovalRequest, AuditDraft, AuditRecorder, ArtifactStore,
  Clock, GrantStore, Hasher, IdempotencyStore, LogField, Logger, PolicyMode, QuotaSnapshot,
  ResolvedTool, RiskClass, SchemaValidator, Task, ToolCall, ToolContext, ToolResolver, ToolResult, Tracer, UsageLedger,
} from '@melon-ai/core';
import { computeScope, decide } from '../policy/index.js';
import { CircuitBreaker } from './breaker.js';
import { DEFAULT_EXECUTE, execute } from './execute.js';
import type { ExecuteConfig } from './execute.js';
import { idempotencyKey, repeatKey } from './argshash.js';
import { emptyMetrics, normalizeErr, normalizeOk } from './normalize.js';
import { toToolError } from './errors.js';
import { GRANTABLE_RISKS, ToolError, asToolId } from '@melon-ai/core';
import type { Grant } from '@melon-ai/core';

export interface PipelineDeps {
  readonly resolver: ToolResolver;
  readonly validator: SchemaValidator;
  readonly grants: GrantStore;
  readonly artifacts: ArtifactStore;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly hasher: Hasher;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly idempotency?: IdempotencyStore;
  /** 配额查询。返回 null 表示不限。 */
  readonly quotaOf?: (agentId: AgentId) => Promise<QuotaSnapshot | null>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly execute?: Partial<ExecuteConfig>;
  readonly idempotencyTtlMs?: number;
  /** 用量账本：声明了 `billing` 的工具每次执行记一笔。不给就不记。 */
  readonly usage?: UsageLedger;
}

/**
 * 准入段（①②③）的返回。
 *
 * **管线刻意分成两次调用**：`admit()` 走 ①②③，`execute()` 走 ④⑤⑥。
 * 因为状态机在第三段与第四段之间插入了一个 `AdmissionResolved` 事件，
 * 而「等用户审批」可能持续数小时 —— 中间必须能落盘，不能把六段捆在一次调用里。
 *
 * `reject` 涵盖解析失败、校验失败与准入拒绝三种，都归一成带错误的 `ToolResult`，
 * 这样运行时对它们与「执行失败」用同一条路径处理，不必分叉。
 */
export type AdmitOutcome =
  | { readonly kind: 'allow'; readonly admission: AdmissionOutcome; readonly risk: RiskClass }
  | { readonly kind: 'ask'; readonly request: ApprovalRequest; readonly admission: AdmissionOutcome; readonly risk: RiskClass }
  | { readonly kind: 'reject'; readonly result: ToolResult; readonly admission: AdmissionOutcome; readonly risk: RiskClass };

/**
 * 工具调用管线。
 *
 * 六段固定顺序：**解析 → 校验 → 准入 → 执行 → 归一化 → 记录**。
 *
 * 设计文档里写的是「中间件链」，实现时改成了**固定管线** ——
 * 通用中间件链允许把某一段插到准入之前、或者整段跳过，
 * 而 §2.7 的全部安全收益正建立在「没有旁路」之上。
 * 想扩展就包装整条管线，或在段内注入依赖，但**段的顺序不可配置**。
 *
 * 「记录」段只写审计。事件由运行时追加 —— 事件日志是单写者，
 * 管线并发调用多个工具时不能各自往里写。
 */
const withoutScope = ({ scope: _scope, ...rest }: Record<string, string | number | boolean>) => rest;

export class ToolPipeline {
  private readonly breaker = new CircuitBreaker();
  /** 没有幂等表时的重复调用缓存（进程内，有上限）。有幂等表时用它，重启后也生效。 */
  private readonly repeats = new Map<string, ToolResult>();
  private rememberRepeat(key: string, result: ToolResult): void {
    if (this.repeats.size >= 500) this.repeats.delete(this.repeats.keys().next().value as string);
    this.repeats.set(key, result);
  }

  constructor(private readonly deps: PipelineDeps) {}

  /** ①②③ 解析 → 校验 → 准入。不执行任何工具。 */
  async admit(task: Task, call: ToolCall, mode: PolicyMode): Promise<AdmitOutcome> {
    const span = this.deps.tracer.startSpan(`tool:${call.toolId}`, 'tool', task.trace);
    const t0 = this.deps.clock.now();
    try {
      // ── ① 解析（按任务的 toolset 快照，否则事件日志不可重放）──
      const resolved = await this.deps.resolver.resolve(call.toolId, task.toolset);
      if (!resolved) {
        // 模型可能幻觉出一个不存在的工具名 —— 当成可修复错误回喂，而不是致命错误
        return this.fail(call, {
          code: 'INVALID_ARGS',
          message: `工具 ${call.toolId} 不存在，或者在本任务开始之后它的定义变了（来源更新了这个工具）`,
          retriable: false,
          hint: '只能用本轮提供的工具，换一个或直接回答',
        }, t0);
      }
      const { descriptor } = resolved;
      span.setAttr('risk', descriptor.risk);

      // ── ② 校验（失败是可修复错误，不计重试）──
      const issues = this.deps.validator.validate(descriptor.input, call.args);
      if (issues.length > 0) {
        return this.fail(call, {
          code: 'INVALID_ARGS',
          message: `参数不合法：${issues.map((i) => `${i.path} ${i.message}`).join('；')}`,
          retriable: false,
          hint: '按 schema 修正参数后重试',
        }, t0);
      }
      // 工具自己的检查（路径不存在、受保护的位置……）：问用户之前就退回给模型
      const pre = descriptor.precheck ? await descriptor.precheck(call.args) : null;
      if (pre) {
        return this.fail(call, {
          code: 'INVALID_ARGS', message: pre.message, retriable: false,
          ...(pre.hint ? { hint: pre.hint } : {}),
        }, t0);
      }

      // ── ③ 准入（四道闸）──
      const gb = descriptor.grantBy;
      const scope = gb ? gb.scope(call.args) : computeScope(descriptor, call.args);
      const [skillEnabled, grant, quota] = await Promise.all([
        this.deps.resolver.isEnabledFor(call.toolId, task.agentId),
        // 按文件夹这类授权：找一条覆盖这次范围的（不是精确相等）
        gb
          ? this.deps.grants.listByAgent(task.agentId).then((all) => all.find((g) => g.toolId === gb.key && gb.covers(g.scope, scope)) ?? null)
          : this.deps.grants.find(task.agentId, call.toolId, scope),
        this.deps.quotaOf ? this.deps.quotaOf(task.agentId) : Promise.resolve(null),
      ]);
      const admission = decide({
        agentId: task.agentId,
        toolId: call.toolId,
        risk: descriptor.risk,
        scope,
        mode,
        tainted: task.tainted,
        skillEnabled,
        grant,
        quota,
        now: this.deps.clock.now(),
        ...(gb ? { grantBy: gb } : {}),
      });
      span.setAttr('admission', admission.decision);

      await this.recordAudit(task, call, 'approval.decide', admission.decision, {
        ...admission.basis, risk: descriptor.risk,
      });

      if (admission.decision === 'ask') {
        return {
          kind: 'ask',
          admission,
          risk: descriptor.risk,
          request: {
            callId: call.callId,
            toolId: call.toolId,
            risk: descriptor.risk,
            summary: admission.reason,
          },
        };
      }
      if (admission.decision === 'deny') {
        const result = normalizeErr({
          code: 'DENIED', message: admission.reason, retriable: false,
          hint: '不要重试这个调用，换一种方式或向用户说明',
        }, emptyMetrics(this.deps.clock.now() - t0));
        return { kind: 'reject', result, admission, risk: descriptor.risk };
      }

      return { kind: 'allow', admission, risk: descriptor.risk };
    } finally {
      span.end({ ok: true });
    }
  }

  /**
   * ④⑤⑥ 执行 → 归一化 → 记录。
   *
   * **不重判准入** —— 已经判过了，重判可能因配额变化得出不同结果，
   * 而用户刚刚批准的是当时那个判定。
   */
  /** `signal`：任务被取消时由运行时中断（工具收到 `cx.signal`）。 */
  async execute(task: Task, call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const t0 = this.deps.clock.now();
    const resolved = await this.deps.resolver.resolve(call.toolId, task.toolset);
    if (!resolved) {
      return normalizeErr({
        code: 'FATAL', message: `工具 ${call.toolId} 已不可解析（审批期间工具集可能变了）`, retriable: false,
      }, emptyMetrics(this.deps.clock.now() - t0));
    }
    return this.run(task, call, resolved, t0, signal);
  }

  // ── ④ 执行 → ⑤ 归一化 → ⑥ 记录 ──
  private async run(task: Task, call: ToolCall, resolved: ResolvedTool, t0: number, signal?: AbortSignal): Promise<ToolResult> {
    const { descriptor, handler } = resolved;
    const key = descriptor.idempotent
      ? undefined
      : idempotencyKey(this.deps.hasher, call.toolId, call.callId, call.args);

    /*
     * 重复调用缓存：同一任务里、同一个幂等工具、参数完全相同，直接返回上次成功的结果。
     * 模型常会反复读同一份东西（实测 DeepSeek 连读 4 次同一个句柄），再跑一遍只是白花时间和配额。
     * 返回里说明是复用的 —— 模型得知道「再调也一样」，不然它会接着调。
     * 只缓存成功的结果；失败的下次还该真的再试。
     */
    const rKey = descriptor.idempotent ? repeatKey(this.deps.hasher, task.id, call.toolId, call.args) : undefined;
    if (rKey !== undefined) {
      const prev = this.deps.idempotency ? await this.deps.idempotency.get(rKey) : this.repeats.get(rKey);
      if (prev) {
        this.deps.logger.log('info', '重复调用命中缓存，直接复用上次结果', { toolId: call.toolId, callId: call.callId });
        return {
          ...prev,
          summary: `（这与本任务中之前的一次调用完全相同，结果不会变化，以下是上次的结果。不要再重复调用。）\n${prev.summary}`,
          metrics: emptyMetrics(0),
        };
      }
    }

    // 幂等短路：effect 重跑（崩溃恢复）时不要真的再发一次邮件
    if (key !== undefined && this.deps.idempotency) {
      const cached = await this.deps.idempotency.get(key);
      if (cached) {
        this.deps.logger.log('info', '幂等命中，跳过实际执行', { toolId: call.toolId, callId: call.callId });
        return cached;
      }
    }

    const ctl = new AbortController();
    // 任务取消：把中断传给工具（读网页、跑脚本、MCP 调用都看 cx.signal）
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    const cx: ToolContext = {
      taskId: task.id,
      callId: call.callId,
      trace: this.deps.tracer.child(task.trace),
      signal: ctl.signal,
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      putArtifact: async (data, meta) => this.deps.artifacts.put(task.id, data, meta),
      readArtifact: async (ref, range) => {
        // 跨任务读取直接拒 —— 句柄是可猜的，不校验等于开了一个横向读取的口子
        const meta = await this.deps.artifacts.stat(ref);
        // 附件（用户随这一轮给的文件，含沿用之前轮次的）也能读
        const attached = (task.attachments ?? []).some((a) => a.textRef === ref);
        if (!meta || (meta.taskId !== task.id && !attached)) {
          throw new ToolError('NOT_FOUND', `句柄 ${ref} 不存在或不属于本任务`, {
            hint: '只能读取本次任务中产生的 artifact',
          });
        }
        const bytes = await this.deps.artifacts.read(ref, range);
        return new TextDecoder().decode(bytes);
      },
      log: (level, msg, fields?: Readonly<Record<string, LogField>>) =>
        this.deps.logger.log(level, msg, { ...fields, toolId: call.toolId }),
    };

    const cfg: ExecuteConfig = { ...DEFAULT_EXECUTE, ...this.deps.execute };
    const ex = await execute(call.toolId, handler, call.args, cx, cfg, {
      now: () => this.deps.clock.now(),
      sleep: this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      breaker: this.breaker,
    });

    const metrics = { ms: ex.ms, bytes: 0, retries: ex.retries };
    const normalized = ex.output
      ? await normalizeOk({ output: ex.output, metrics, cx, ...(descriptor.outputLimit ? { limit: descriptor.outputLimit } : {}) })
      : normalizeErr(ex.error ?? toToolError(new Error('未知失败')), metrics);
    // 失败也标：错误信息里同样可能带着远端返回的内容
    const result = descriptor.untrustedOutput ? { ...normalized, untrusted: true } : normalized;

    if (key !== undefined && this.deps.idempotency && result.ok) {
      await this.deps.idempotency.put(key, result, this.deps.idempotencyTtlMs ?? 3_600_000);
    }
    if (rKey !== undefined && result.ok) {
      if (this.deps.idempotency) await this.deps.idempotency.put(rKey, result, this.deps.idempotencyTtlMs ?? 3_600_000);
      else this.rememberRepeat(rKey, result);
    }

    if (descriptor.billing && this.deps.usage) {
      const b = descriptor.billing;
      // 只有成功的按次计费；记账失败不影响这次调用
      await this.deps.usage.record({
        at: this.deps.clock.now(), calls: 1, taskId: task.id, agentId: task.agentId, taskKind: task.kind, trigger: task.trigger.type,
        purpose: 'tool', egress: b.vendor, model: call.toolId, ok: result.ok, ...(result.error ? { errorCode: result.error.code } : {}),
        inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
        cost: result.ok && b.perCall ? b.perCall.amount : 0, currency: b.perCall?.currency ?? 'CNY', priced: !!b.perCall, ms: ex.ms,
      }).catch((e) => this.deps.logger.log('warn', `用量记账失败：${e instanceof Error ? e.message : String(e)}`, { toolId: call.toolId }));
    }

    await this.recordAudit(task, call, 'tool.invoke', result.ok ? 'ok' : 'error', {
      risk: descriptor.risk,
      retries: ex.retries,
      ms: ex.ms,
      ...(result.error ? { errorCode: result.error.code } : {}),
    });

    return result;
  }

  /** 解析/校验失败。risk 用 `read` 占位 —— 它只用于构造审批请求，而这条路永不询问。 */
  private fail(call: ToolCall, error: Parameters<typeof normalizeErr>[0], t0: number): AdmitOutcome {
    const result = normalizeErr(error, emptyMetrics(this.deps.clock.now() - t0));
    return {
      kind: 'reject',
      result,
      risk: 'read',
      // 提示要进观察结果：模型靠它改参数（「可能是 ~/Downloads」「按 schema 修正」），只给错误它不知道往哪改
      admission: { decision: 'deny', reason: error.hint ? `${error.message}。${error.hint}` : error.message, basis: { gate: 'validate' } },
    };
  }

  /** §2.4：审计只存引用与维度，不存 payload。 */
  /**
   * 用户点了「始终允许」：记下这个工具、这个范围的授权。
   *
   * 范围与准入时算的是同一个（`computeScope`），所以下次同样的调用在第 ④ 道闸命中。
   * 污点覆盖仍在授权之前（第 ③ 道闸），授权放不过读过网页的任务。
   * 幂等：崩溃恢复重发时再写一次同样的记录。
   */
  async grant(task: Task, call: ToolCall): Promise<Grant | null> {
    const resolved = await this.deps.resolver.resolve(call.toolId, task.toolset);
    if (!resolved || !GRANTABLE_RISKS.includes(resolved.descriptor.risk)) return null;
    const gb = resolved.descriptor.grantBy;
    const g: Grant = {
      agentId: task.agentId,
      toolId: gb ? asToolId(gb.key) : call.toolId,
      scope: gb ? gb.scope(call.args) : computeScope(resolved.descriptor, call.args),
      grantedAt: this.deps.clock.now(),
    };
    await this.deps.grants.put(g);
    await this.deps.audit.record({
      at: g.grantedAt,
      actor: { kind: 'user', id: 'user' },
      action: 'policy.change',
      resource: { kind: 'grant', ref: g.toolId },
      outcome: 'allow',
      traceId: task.trace.traceId,
      spanId: task.trace.spanId,
      taskId: task.id,
      dimensions: { toolId: g.toolId, change: 'grant' },
      // 范围可读（`scope.ts`：用户要能复核授权过什么），放在依据里 —— 维度有长度上限，多个收件人就超了
      basis: { decision: 'always', callId: call.callId, scope: g.scope },
    });
    return g;
  }

  private async recordAudit(
    task: Task,
    call: ToolCall,
    action: AuditDraft['action'],
    outcome: AuditDraft['outcome'],
    dimensions: Record<string, string | number | boolean>,
  ): Promise<void> {
    await this.deps.audit.record({
      at: this.deps.clock.now(),
      actor: { kind: 'agent', id: task.agentId },
      action,
      resource: { kind: 'tool-call', ref: call.callId, contentHash: call.argsHash },
      outcome,
      traceId: task.trace.traceId,
      spanId: task.trace.spanId,
      taskId: task.id,
      // scope 是收件人这类内容、长度不定：维度有 64 字上限（超了审计抛错，准入跟着失败），只放进依据
      dimensions: { toolId: call.toolId, ...withoutScope(dimensions) },
      basis: dimensions,
    });
  }
}
