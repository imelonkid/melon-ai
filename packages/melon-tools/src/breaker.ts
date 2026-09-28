export interface BreakerConfig {
  /** 连续失败多少次打开熔断。 */
  readonly threshold: number;
  /** 打开后多久进入半开。 */
  readonly cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, cooldownMs: 30_000 };

type State = 'closed' | 'open' | 'half-open';

interface Entry {
  failures: number;
  state: State;
  openedAt: number;
}

/**
 * 每工具独立的熔断器。
 *
 * 一个挂掉的 MCP server 不该把整个 Agent 拖死 ——
 * 尤其在 ReAct 循环里，模型会反复尝试同一个工具，没有熔断就是 24 步全部浪费在超时上。
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly cfg: BreakerConfig = DEFAULT_BREAKER) {}

  /** 返回 null 表示可以放行；否则返回恢复尝试的时间点。 */
  check(toolId: string, now: number): number | null {
    const e = this.entries.get(toolId);
    if (!e || e.state === 'closed') return null;
    if (e.state === 'open' && now - e.openedAt >= this.cfg.cooldownMs) {
      e.state = 'half-open';
      return null; // 半开：放一次探测通过
    }
    return e.state === 'half-open' ? null : e.openedAt + this.cfg.cooldownMs;
  }

  onSuccess(toolId: string): void {
    this.entries.delete(toolId);
  }

  onFailure(toolId: string, now: number): void {
    const e = this.entries.get(toolId) ?? { failures: 0, state: 'closed' as State, openedAt: 0 };
    e.failures += 1;
    // 半开状态下再失败立刻回到打开，不等攒够阈值
    if (e.state === 'half-open' || e.failures >= this.cfg.threshold) {
      e.state = 'open';
      e.openedAt = now;
    }
    this.entries.set(toolId, e);
  }

  stateOf(toolId: string): State {
    return this.entries.get(toolId)?.state ?? 'closed';
  }
}
