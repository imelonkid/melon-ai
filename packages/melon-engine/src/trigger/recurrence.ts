import type { Recurrence, TimeOfDay, Weekday } from '@melon-ai/core';

/**
 * ─── 算下一次触发时间 ───
 *
 * **纯函数**：不读时钟、不碰存储、不看当前状态（§2.3、§4.8 边界二）。
 * 时区和 DST 是这块唯一真正难的部分，纯函数才能直接拿
 * 「2026-03-08 美东」这种日期喂进去断言，不用等半年才发现差一小时。
 */

const DAY = 86_400_000;

/**
 * 把一个时间戳按目标时区拆成年月日时分。
 *
 * 用 `Intl.DateTimeFormat` 而不是自己算偏移量：偏移量在 DST 边界上是错的，
 * 而 `Intl` 带完整的 IANA 时区库。Node 和浏览器都有，不破坏 §2.8。
 */
function partsIn(tz: string, at: number): { y: number; m: number; d: number; hh: number; mm: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const got: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(at))) got[p.type] = p.value;
  return {
    y: Number(got.year), m: Number(got.month), d: Number(got.day),
    // Intl 在 hour12:false 下把午夜给成 "24"，不是 "00"
    hh: Number(got.hour) % 24, mm: Number(got.minute),
  };
}

/** 某时刻在目标时区的 UTC 偏移（毫秒）。DST 前后不同，所以必须按时刻算。 */
function offsetAt(tz: string, at: number): number {
  const p = partsIn(tz, at);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  // 抹掉秒和毫秒再比，否则余数会混进偏移量
  const floored = Math.floor(at / 60_000) * 60_000;
  return asUTC - floored;
}

/**
 * 「目标时区的 y-m-d hh:mm」对应哪个时间戳。
 *
 * 偏移量本身依赖答案（先有时刻才有偏移），所以迭代两次：第一次用猜测时刻的偏移，
 * 第二次用修正后时刻的偏移。DST 切换当天第一次会差一小时，第二次收敛。
 */
function timestampOf(tz: string, y: number, m: number, d: number, t: TimeOfDay): number {
  const naive = Date.UTC(y, m - 1, d, t.hour, t.minute);
  let ts = naive - offsetAt(tz, naive);
  ts = naive - offsetAt(tz, ts);
  return ts;
}

/**
 * DST「春季前跳」那天，2:30 这个本地时刻不存在。
 *
 * 此时 `timestampOf` 会算出一个落回 1:30 或跳到 3:30 的时刻。
 * 约定：**取跳变之后的第一个瞬间**（也就是 3:00），宁可晚跑半小时也不漏跑一天。
 */
function resolveLocal(tz: string, y: number, m: number, d: number, t: TimeOfDay): number {
  const ts = timestampOf(tz, y, m, d, t);
  const back = partsIn(tz, ts);
  if (back.hh === t.hour && back.mm === t.minute) return ts;
  // 不存在的本地时刻：往后找到第一个日期还对得上的整分钟
  for (let step = 1; step <= 180; step++) {
    const probe = ts + step * 60_000;
    const p = partsIn(tz, probe);
    if (p.d === d && (p.hh > t.hour || (p.hh === t.hour && p.mm >= t.minute))) return probe;
  }
  return ts;
}

/** 目标时区里，`at` 那天的年月日。 */
function dayIn(tz: string, at: number): { y: number; m: number; d: number } {
  const { y, m, d } = partsIn(tz, at);
  return { y, m, d };
}

function weekdayIn(tz: string, at: number): Weekday {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(at));
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return (idx < 0 ? 0 : idx) as Weekday;
}

/**
 * 严格晚于 `after` 的下一次触发时刻；不会再触发时返回 `null`。
 *
 * 「严格晚于」很重要：`fire()` 之后拿刚触发的时刻再算一次，必须前进，
 * 否则同一时刻会被反复触发。
 */
export function nextFireAt(rule: Recurrence, after: number): number | null {
  switch (rule.kind) {
    case 'once':
      return rule.at > after ? rule.at : null;

    case 'interval': {
      if (!(rule.everyMs > 0)) return null;
      return after + rule.everyMs;
    }

    case 'daily': {
      // 从 after 当天起试，最多跨两天（DST 那天当天的时刻可能已经过了）
      for (let i = 0; i <= 2; i++) {
        const { y, m, d } = dayIn(rule.tz, after + i * DAY);
        const ts = resolveLocal(rule.tz, y, m, d, rule.time);
        if (ts > after) return ts;
      }
      return null;
    }

    case 'weekly': {
      if (rule.days.length === 0) return null;
      const want = new Set(rule.days);
      // 最多跨 8 天：一周里总有一天命中，多一天兜 DST
      for (let i = 0; i <= 8; i++) {
        const probe = after + i * DAY;
        if (!want.has(weekdayIn(rule.tz, probe))) continue;
        const { y, m, d } = dayIn(rule.tz, probe);
        const ts = resolveLocal(rule.tz, y, m, d, rule.time);
        if (ts > after) return ts;
      }
      return null;
    }
  }
}

/**
 * 补跑：从 `lastFireAt` 一路推到 `now`，返回这段时间里错过的触发次数和
 * 下一次该触发的时刻。
 *
 * 次数交给调用方决定怎么用（`catchUp: 'skip'` 就是无视次数只往前推）。
 * 上限 `maxSteps` 防止「每分钟」的规则停机半年后在这里空转几十万次。
 */
export function advancePast(
  rule: Recurrence,
  from: number,
  now: number,
  maxSteps = 10_000,
): { readonly missed: number; readonly next: number | null } {
  let cursor = from;
  let missed = 0;
  for (let i = 0; i < maxSteps; i++) {
    const next = nextFireAt(rule, cursor);
    if (next === null) return { missed, next: null };
    if (next > now) return { missed, next };
    missed += 1;
    cursor = next;
  }
  return { missed, next: nextFireAt(rule, cursor) };
}
