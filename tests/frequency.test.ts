import { describe, expect, it } from "vitest";
import { assessFrequencyHealth, dynamicThresholdDelta } from "@/engine/learning/frequency";
import { computeFilterEffectiveness, WINNER_GAIN_PCT } from "@/engine/learning/missed";
import type { ClosedTrade } from "@/engine/learning/tradeStats";

const NOW = new Date("2026-07-14T12:00:00Z");
const dayMs = 86_400_000;

function closedTrade(daysAgo: number, pnlSol: number): ClosedTrade {
  const closedAt = new Date(NOW.getTime() - daysAgo * dayMs);
  return {
    pnlSol,
    pnlPct: pnlSol * 100,
    entrySol: 0.1,
    openedAt: new Date(closedAt.getTime() - 5 * 60_000),
    closedAt,
    exitReason: null,
    exitKind: pnlSol > 0 ? "take_profit" : "stop_loss",
    entryReason: null,
    score: 75,
    entryMarketCapUsd: null,
    entryLiquiditySol: null,
    tokenAgeMinAtEntry: null,
    detectionToBuyMs: null,
    maxUnrealizedPnlPct: null,
    maxDrawdownPct: null,
    entryMetrics: null,
    entryContext: null,
    paper: true,
  };
}

describe("frequency health (never optimize for win rate alone)", () => {
  it("flags over-selectivity when frequency AND daily profit both fell", () => {
    const trades: ClosedTrade[] = [];
    // prior week: 4/day at +0.01 each; recent week: 1/day at +0.01 each
    for (let d = 8; d < 14; d++) for (let i = 0; i < 4; i++) trades.push(closedTrade(d + i * 0.01, 0.01));
    for (let d = 1; d < 7; d++) trades.push(closedTrade(d, 0.01));
    const h = assessFrequencyHealth(trades, NOW);
    expect(h.status).toBe("over_selective");
    expect(h.detail).toMatch(/filtering away/);
  });

  it("does NOT flag when fewer trades made MORE money (filtering worked)", () => {
    const trades: ClosedTrade[] = [];
    for (let d = 8; d < 14; d++) for (let i = 0; i < 4; i++) trades.push(closedTrade(d + i * 0.01, -0.002));
    for (let d = 1; d < 7; d++) trades.push(closedTrade(d, 0.02)); // fewer, better
    const h = assessFrequencyHealth(trades, NOW);
    expect(h.status).toBe("healthy");
  });

  it("flags over-trading when volume rose but EV and daily profit fell", () => {
    const trades: ClosedTrade[] = [];
    for (let d = 8; d < 14; d++) trades.push(closedTrade(d, 0.02));
    for (let d = 1; d < 7; d++) for (let i = 0; i < 5; i++) trades.push(closedTrade(d + i * 0.01, -0.001));
    const h = assessFrequencyHealth(trades, NOW);
    expect(h.status).toBe("over_trading");
  });

  it("stays quiet without enough data", () => {
    expect(assessFrequencyHealth([closedTrade(1, 0.01)], NOW).status).toBe("insufficient_data");
  });
});

describe("market-quality-adaptive threshold", () => {
  it("loosens in good markets and tightens in poor ones, bounded ±7", () => {
    expect(dynamicThresholdDelta("pump_mania").delta).toBeLessThan(0);
    expect(dynamicThresholdDelta("bull_trend").delta).toBeLessThan(0);
    expect(dynamicThresholdDelta("sideways").delta).toBe(0);
    expect(dynamicThresholdDelta("bear_trend").delta).toBeGreaterThan(0);
    expect(dynamicThresholdDelta("risk_off").delta).toBe(7);
    expect(dynamicThresholdDelta(null).delta).toBe(0);
  });

  it("feeds measured frequency problems back into the shift, still bounded", () => {
    const overSel = { status: "over_selective" } as Parameters<typeof dynamicThresholdDelta>[1];
    expect(dynamicThresholdDelta("bull_trend", overSel)!.delta).toBe(-5);
    const overTrade = { status: "over_trading" } as Parameters<typeof dynamicThresholdDelta>[1];
    expect(dynamicThresholdDelta("risk_off", overTrade)!.delta).toBe(7); // capped
  });
});

describe("filter effectiveness (Phase 2)", () => {
  it("grades each gate on saved vs missed winners", () => {
    const rows = [
      // liquidity gate: 3 rejections — 2 rugged, 1 became a +120% winner
      { hardFailRules: ["minimum liquidity"], maxGainPct: 5, rugged: true },
      { hardFailRules: ["minimum liquidity"], maxGainPct: -60, rugged: true },
      { hardFailRules: ["minimum liquidity"], maxGainPct: 120, rugged: false },
      // no hard rule = score threshold
      { hardFailRules: [], maxGainPct: 10, rugged: false },
    ];
    const eff = computeFilterEffectiveness(rows);
    const liq = eff.find((f) => f.rule === "minimum liquidity")!;
    expect(liq.rejected).toBe(3);
    expect(liq.saved).toBe(2);
    expect(liq.missedWinners).toBe(1);
    expect(liq.accuracyPct).toBeCloseTo((2 / 3) * 100, 1);
    expect(liq.missedPnlPct).toBeCloseTo(120);
    const score = eff.find((f) => f.rule === "score below threshold")!;
    expect(score.saved).toBe(1); // +10% is not a ≥ +50% winner
    expect(WINNER_GAIN_PCT).toBe(50);
  });

  it("a rugged token never counts as a missed winner regardless of its peak", () => {
    const eff = computeFilterEffectiveness([
      { hardFailRules: ["rug risk"], maxGainPct: 300, rugged: true }, // pumped then rugged
    ]);
    expect(eff[0].saved).toBe(1);
    expect(eff[0].missedWinners).toBe(0);
    expect(eff[0].accuracyPct).toBe(100);
  });
});
