import type {
  AdmissionOutcome, AgentId, ApprovalRequest, AuditDraft, AuditRecorder, ArtifactStore,
  Clock, GrantStore, Hasher, IdempotencyStore, LogField, Logger, PolicyMode, QuotaSnapshot,
  ResolvedTool, SchemaValidator, Task, ToolCall, ToolContext, ToolResolver, ToolResult, Tracer,
} from '@melon-ai/core';
import { computeScope, decide } from '@melon-ai/policy';
import { CircuitBreaker } from './breaker.js';
import { DEFAULT_EXECUTE, execute } from './execute.js';
import type { ExecuteConfig } from './execute.js';
import { idempotencyKey } from './argshash.js';
import { emptyMetrics, normalizeErr, normalizeOk } from './normalize.js';
import { toToolError } from './errors.js';

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
}

/**
 * 管线的返回。
 *
 * `needs-approval` 是唯一的特殊分支 —— 拒绝走 `executed`（带 DENIED 错误的 ToolResult），
 * 这样运行时对「被拒」和「执行失败」用同一条路径处理，不必分叉。
 */
export type InvokeOutcome =
  | { readonly kind: 'executed'; readonly result: ToolResult; readonly admission: AdmissionOutcome }
  | { readonly kind: 'needs-approval'; readonly request: ApprovalRequest; readonly admission: AdmissionOutcome };

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
export class ToolPipeline {
  private readonly breaker = new CircuitBreaker();

  constructor(private readonly deps: PipelineDeps) {}

  async invoke(task: Task, call: ToolCall, mode: PolicyMode): Promise<InvokeOutcome> {
    const span = this.deps.tracer.startSpan(`tool:${call.toolId}`, 'tool', task.trace);
    const t0 = this.deps.clock.now();
    try {
      // ── ① 解析（按任务的 toolset 快照，否则事件日志不可重放）──
      const resolved = await this.deps.resolver.resolve(call.toolId, task.toolset);
      if (!resolved) {
        // 模型可能幻觉出一个不存在的工具名 —— 当成可修复错误回喂，而不是致命错误
        return this.fail(call, {
          code: 'INVALID_ARGS',
          message: `工具 ${call.toolId} 不存在或未在本任务的工具集快照中`,
          retriable: false,
          hint: '用 builtin.skill_find 重新查找可用工具',
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

      // ── ③ 准入（四道闸）──
      const scope = computeScope(descriptor, call.args);
      const [skillEnabled, grant, quota] = await Promise.all([
        this.deps.resolver.isEnabledFor(call.toolId, task.agentId),
        this.deps.grants.find(task.agentId, call.toolId, scope),
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
      });
      span.setAttr('admission', admission.decision);

      await this.recordAudit(task, call, 'approval.decide', admission.decision, {
        ...admission.basis, risk: descriptor.risk,
      });

      if (admission.decision === 'ask') {
        return {
          kind: 'needs-approval',
          admission,
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
        return { kind: 'executed', result, admission };
      }

      return { kind: 'executed', admission, result: await this.run(task, call, resolved, t0) };
    } finally {
      span.end({ ok: true });
    }
  }

  /** 审批通过后继续。跳过准入 —— 已经判过了，重判可能因配额变化得出不同结果。 */
  async resume(task: Task, call: ToolCall): Promise<ToolResult> {
    const t0 = this.deps.clock.now();
    const resolved = await this.deps.resolver.resolve(call.toolId, task.toolset);
    if (!resolved) {
      return normalizeErr({
        code: 'FATAL', message: `审批后工具 ${call.toolId} 已不可解析`, retriable: false,
      }, emptyMetrics(this.deps.clock.now() - t0));
    }
    return this.run(task, call, resolved, t0);
  }

  // ── ④ 执行 → ⑤ 归一化 → ⑥ 记录 ──
  private async run(task: Task, call: ToolCall, resolved: ResolvedTool, t0: number): Promise<ToolResult> {
    const { descriptor, handler } = resolved;
    const key = descriptor.idempotent
      ? undefined
      : idempotencyKey(this.deps.hasher, call.toolId, call.callId, call.args);

    // 幂等短路：effect 重跑（崩溃恢复）时不要真的再发一次邮件
    if (key !== undefined && this.deps.idempotency) {
      const cached = await this.deps.idempotency.get(key);
      if (cached) {
        this.deps.logger.log('info', '幂等命中，跳过实际执行', { toolId: call.toolId, callId: call.callId });
        return cached;
      }
    }

    const ctl = new AbortController();
    const cx: ToolContext = {
      taskId: task.id,
      callId: call.callId,
      trace: this.deps.tracer.child(task.trace),
      signal: ctl.signal,
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      putArtifact: async (data, meta) => this.deps.artifacts.put(task.id, data, meta),
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
    const result = ex.output
      ? await normalizeOk({ output: ex.output, metrics, cx })
      : normalizeErr(ex.error ?? toToolError(new Error('未知失败')), metrics);

    if (key !== undefined && this.deps.idempotency && result.ok) {
      await this.deps.idempotency.put(key, result, this.deps.idempotencyTtlMs ?? 3_600_000);
    }

    await this.recordAudit(task, call, 'tool.invoke', result.ok ? 'ok' : 'error', {
      risk: descriptor.risk,
      retries: ex.retries,
      ms: ex.ms,
      ...(result.error ? { errorCode: result.error.code } : {}),
    });

    return result;
  }

  private fail(call: ToolCall, error: Parameters<typeof normalizeErr>[0], t0: number): InvokeOutcome {
    const result = normalizeErr(error, emptyMetrics(this.deps.clock.now() - t0));
    return {
      kind: 'executed',
      result,
      admission: { decision: 'deny', reason: error.message, basis: { gate: 'validate' } },
    };
  }

  /** §2.4：审计只存引用与维度，不存 payload。 */
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
      dimensions: { toolId: call.toolId, ...dimensions },
      basis: dimensions,
    });
  }
}
