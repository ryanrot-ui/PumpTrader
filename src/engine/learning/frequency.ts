import { prisma } from "@/lib/prisma";
import type { ClosedTrade } from "./tradeStats";
import type { MarketRegime } from "./regime";

/**
 * Profit–frequency balance. The objective is maximum sustainable daily
 * profit after costs — NOT the highest win rate (selectivity that filters
 * away profit is a bug) and NOT the most trades (volume that dilutes
 * expectancy is a bug).
 *
 * Three tools:
 *  - assessFrequencyHealth: compares the recent window against the prior
 *    one on trades/day AND profit/day, and flags over-selectivity (both
 *    dropped) or over-trading (more trades, worse expectancy and profit)
 *  - dynamicThresholdDelta: market-quality-adaptive confidence threshold —
 *    good markets loosen a few points (more opportunities), poor markets
 *    tighten (more selective). Bounded to ±7 so settings stay in charge.
 *  - investigateBlockers: when frequency drops, answer WHY automatically —
 *    which hard gates rejected the most evaluations recently.
 */

const WINDOW_DAYS = 7;

export interface FrequencyHealth {
  status: "healthy" | "over_selective" | "over_trading" | "insufficient_data";
  recentTradesPerDay: number | null;
  priorTradesPerDay: number | null;
  recentDailyPnlSol: number | null;
  priorDailyPnlSol: number | null;
  recentEvPerTradeSol: number | null;
  priorEvPerTradeSol: number | null;
  detail: string;
}

export function assessFrequencyHealth(trades: ClosedTrade[], now = new Date()): FrequencyHealth {
  const dayMs = 86_400_000;
  const recentStart = now.getTime() - WINDOW_DAYS * dayMs;
  const priorStart = now.getTime() - 2 * WINDOW_DAYS * dayMs;
  const recent = trades.filter((t) => t.closedAt.getTime() >= recentStart);
  const prior = trades.filter(
    (t) => t.closedAt.getTime() >= priorStart && t.closedAt.getTime() < recentStart
  );

  if (recent.length + prior.length < 20 || prior.length < 5) {
    return {
      status: "insufficient_data",
      recentTradesPerDay: recent.length / WINDOW_DAYS,
      priorTradesPerDay: prior.length ? prior.length / WINDOW_DAYS : null,
      recentDailyPnlSol: null,
      priorDailyPnlSol: null,
      recentEvPerTradeSol: null,
      priorEvPerTradeSol: null,
      detail: `only ${recent.length + prior.length} trades across the two ${WINDOW_DAYS}-day windows — no frequency verdict yet`,
    };
  }

  const rFreq = recent.length / WINDOW_DAYS;
  const pFreq = prior.length / WINDOW_DAYS;
  const rPnl = recent.reduce((a, t) => a + t.pnlSol, 0) / WINDOW_DAYS;
  const pPnl = prior.reduce((a, t) => a + t.pnlSol, 0) / WINDOW_DAYS;
  const rEv = recent.length ? recent.reduce((a, t) => a + t.pnlSol, 0) / recent.length : 0;
  const pEv = prior.length ? prior.reduce((a, t) => a + t.pnlSol, 0) / prior.length : 0;

  const base = {
    recentTradesPerDay: rFreq,
    priorTradesPerDay: pFreq,
    recentDailyPnlSol: rPnl,
    priorDailyPnlSol: pPnl,
    recentEvPerTradeSol: rEv,
    priorEvPerTradeSol: pEv,
  };

  // Over-selective: trading much less AND making less per day. If frequency
  // fell but daily profit held or improved, the filtering removed junk —
  // that is the goal, not a problem.
  if (rFreq < pFreq * 0.6 && rPnl < pPnl) {
    return {
      ...base,
      status: "over_selective",
      detail:
        `trade frequency fell ${((1 - rFreq / pFreq) * 100).toFixed(0)}% (${pFreq.toFixed(1)} → ${rFreq.toFixed(1)}/day) ` +
        `AND daily profit fell (${pPnl.toFixed(3)} → ${rPnl.toFixed(3)} SOL/day) — selectivity is filtering away profitable opportunities`,
    };
  }
  // Over-trading: more trades, worse per-trade expectancy AND worse daily profit.
  if (rFreq > pFreq * 1.5 && rEv < pEv && rPnl < pPnl) {
    return {
      ...base,
      status: "over_trading",
      detail:
        `trade frequency rose ${((rFreq / pFreq - 1) * 100).toFixed(0)}% but per-trade EV fell ` +
        `(${pEv.toFixed(4)} → ${rEv.toFixed(4)} SOL) and daily profit fell — extra trades are diluting the edge`,
    };
  }
  return {
    ...base,
    status: "healthy",
    detail: `${rFreq.toFixed(1)} trades/day at ${rPnl.toFixed(3)} SOL/day (prior window: ${pFreq.toFixed(1)}/day, ${pPnl.toFixed(3)} SOL/day)`,
  };
}

/**
 * Market-quality-adaptive confidence threshold: how many points to shift
 * the configured threshold for current conditions. Negative = allow more
 * trades (good market), positive = more selective (poor market). Bounded.
 */
export function dynamicThresholdDelta(
  regime: MarketRegime | null,
  freq?: FrequencyHealth | null
): { delta: number; reason: string } {
  let delta = 0;
  let reason = "average market — configured threshold unchanged";
  switch (regime) {
    case "pump_mania":
      delta = -4;
      reason = "excellent market (pump mania: broad demand) — allowing more trades";
      break;
    case "bull_trend":
      delta = -3;
      reason = "good market (bull trend) — allowing more trades";
      break;
    case "sideways":
      delta = 0;
      reason = "average market (sideways) — configured threshold unchanged";
      break;
    case "high_volatility":
      delta = 3;
      reason = "whipsaw market (high volatility) — more selective";
      break;
    case "low_volatility":
      delta = 2;
      reason = "quiet market (low volatility) — slightly more selective";
      break;
    case "bear_trend":
      delta = 5;
      reason = "poor market (bear trend) — significantly more selective";
      break;
    case "risk_off":
      delta = 7;
      reason = "hostile market (risk-off) — maximum selectivity";
      break;
    default:
      return { delta: 0, reason: "market regime unknown — configured threshold unchanged" };
  }
  // Feedback loop: measured over-selectivity loosens slightly, measured
  // over-trading tightens slightly — always inside the same bounds.
  if (freq?.status === "over_selective") delta -= 2;
  if (freq?.status === "over_trading") delta += 2;
  delta = Math.max(-7, Math.min(7, delta));
  return { delta, reason };
}

export interface BlockerStat {
  rule: string;
  count: number;
}

/**
 * "Why did we stop trading?" — counts which hard gates failed most across
 * recent evaluations, straight from the persisted decision traces.
 */
export async function investigateBlockers(sinceDays = 7): Promise<BlockerStat[]> {
  const rows = await prisma.detectedToken.findMany({
    where: {
      detectedAt: { gte: new Date(Date.now() - sinceDays * 86_400_000) },
      verdict: { in: ["REJECTED", "WATCH", "IGNORED"] },
      decisionTrace: { not: undefined },
    },
    select: { decisionTrace: true },
    orderBy: { detectedAt: "desc" },
    take: 400,
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    const trace = r.decisionTrace as Array<{ rule?: string; hard?: boolean; passed?: boolean }> | null;
    if (!Array.isArray(trace)) continue;
    for (const rule of trace) {
      if (rule.hard && rule.passed === false && rule.rule) {
        counts.set(rule.rule, (counts.get(rule.rule) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}
