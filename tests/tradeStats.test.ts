import { describe, expect, it } from "vitest";
import {
  classifyExitKind,
  computeTradeStats,
  type ClosedTrade,
} from "@/engine/learning/tradeStats";
import { optimizeWeights, MIN_TRADES_FOR_OPTIMIZATION } from "@/engine/learning/optimizer";
import { DEFAULT_WEIGHTS } from "@/engine/analysis/scoring";

const T0 = new Date("2026-07-01T10:00:00Z").getTime();

function trade(overrides: Partial<ClosedTrade> & { pnlSol: number }, i = 0): ClosedTrade {
  const openedAt = new Date(T0 + i * 3_600_000);
  return {
    pnlPct: overrides.pnlSol * 100, // proportional default
    entrySol: 0.1,
    openedAt,
    closedAt: new Date(openedAt.getTime() + 5 * 60_000),
    exitReason: null,
    exitKind: overrides.pnlSol > 0 ? "take_profit" : "stop_loss",
    entryReason: null,
    score: 75,
    entryMarketCapUsd: 120_000,
    entryLiquiditySol: 80,
    tokenAgeMinAtEntry: 5,
    detectionToBuyMs: 4_000,
    maxUnrealizedPnlPct: null,
    maxDrawdownPct: null,
    entryMetrics: null,
    paper: true,
    ...overrides,
  };
}

describe("computeTradeStats", () => {
  it("computes core metrics on a known series", () => {
    // 2 winners (+0.02, +0.04), 2 losers (-0.01, -0.01)
    const s = computeTradeStats([
      trade({ pnlSol: 0.02 }, 0),
      trade({ pnlSol: -0.01 }, 1),
      trade({ pnlSol: 0.04 }, 2),
      trade({ pnlSol: -0.01 }, 3),
    ]);
    expect(s.trades).toBe(4);
    expect(s.winRate).toBe(50);
    expect(s.avgWinnerSol).toBeCloseTo(0.03);
    expect(s.avgLoserSol).toBeCloseTo(0.01);
    expect(s.profitFactor).toBeCloseTo(0.06 / 0.02);
    // expectancy = 0.5*0.03 - 0.5*0.01 = 0.01
    expect(s.expectancySol).toBeCloseTo(0.01);
    expect(s.avgRiskReward).toBeCloseTo(3);
    expect(s.totalPnlSol).toBeCloseTo(0.04);
  });

  it("computes max drawdown from the equity curve", () => {
    // equity: +0.05 → +0.02 → -0.02 → +0.03 ⇒ deepest fall from 0.05 to -0.02 = 0.07
    const s = computeTradeStats([
      trade({ pnlSol: 0.05 }, 0),
      trade({ pnlSol: -0.03 }, 1),
      trade({ pnlSol: -0.04 }, 2),
      trade({ pnlSol: 0.05 }, 3),
    ]);
    expect(s.maxDrawdownSol).toBeCloseTo(0.07);
  });

  it("tracks streaks in close order", () => {
    const s = computeTradeStats([
      trade({ pnlSol: 0.01 }, 0),
      trade({ pnlSol: 0.01 }, 1),
      trade({ pnlSol: 0.01 }, 2),
      trade({ pnlSol: -0.01 }, 3),
      trade({ pnlSol: -0.01 }, 4),
    ]);
    expect(s.maxConsecutiveWins).toBe(3);
    expect(s.maxConsecutiveLosses).toBe(2);
    expect(s.currentStreak).toBe(-2);
  });

  it("separates hold times of winners and losers and measures giveback", () => {
    const s = computeTradeStats([
      trade(
        {
          pnlSol: 0.02,
          pnlPct: 10,
          maxUnrealizedPnlPct: 25, // gave back 15
          closedAt: new Date(T0 + 2 * 60_000),
        },
        0
      ),
      trade(
        {
          pnlSol: -0.02,
          pnlPct: -10,
          maxUnrealizedPnlPct: 8, // peaked ≥5% then closed red = round trip
          closedAt: new Date(T0 + 3_600_000 + 20 * 60_000),
        },
        1
      ),
    ]);
    expect(s.avgHoldMinutesWinners).toBeCloseTo(2);
    expect(s.avgHoldMinutesLosers).toBeCloseTo(20);
    expect(s.avgGivebackPct).toBeCloseTo(15);
    expect(s.roundTrips).toBe(1);
  });

  it("buckets by score range and exit kind", () => {
    const s = computeTradeStats([
      trade({ pnlSol: 0.02, score: 92 }, 0),
      trade({ pnlSol: -0.01, score: 65 }, 1),
      trade({ pnlSol: 0.01, score: 95, exitKind: "trailing_stop" }, 2),
    ]);
    const hi = s.byScore.find((b) => b.label === "90-100");
    expect(hi?.trades).toBe(2);
    expect(hi?.winRate).toBe(100);
    const lo = s.byScore.find((b) => b.label === "60-69");
    expect(lo?.pnlSol).toBeCloseTo(-0.01);
    expect(s.byExitKind.map((b) => b.label)).toContain("trailing_stop");
  });

  it("classifies free-text exit reasons", () => {
    expect(classifyExitKind("take profit: +13.2% ≥ +12% target")).toBe("take_profit");
    expect(classifyExitKind("trailing stop: 5.2% off peak")).toBe("trailing_stop");
    expect(classifyExitKind("buy pressure faded: 5m buy/sell 0.60 < 0.75")).toBe("momentum_exit");
    expect(classifyExitKind("liquidity dropped -40% — emergency exit")).toBe("rug_exit");
    expect(classifyExitKind("weak position: 0.3% after 4.0 min")).toBe("weak_exit");
    expect(classifyExitKind(null)).toBe("unknown");
  });
});

describe("optimizeWeights", () => {
  it("returns null below the minimum sample size", () => {
    const trades = Array.from({ length: MIN_TRADES_FOR_OPTIMIZATION - 1 }, (_, i) =>
      trade({ pnlSol: 0.01, entryMetrics: { momentum: 0.8 } }, i)
    );
    expect(optimizeWeights(trades)).toBeNull();
  });

  it("increases weight for metrics that predict wins and decreases for anti-predictive ones", () => {
    // momentum high on winners / low on losers; stability the opposite.
    const trades: ClosedTrade[] = [];
    for (let i = 0; i < 60; i++) {
      const win = i % 2 === 0;
      trades.push(
        trade(
          {
            pnlSol: win ? 0.02 : -0.015,
            entryMetrics: {
              momentum: win ? 0.9 : 0.2,
              stability: win ? 0.2 : 0.9,
              liquidity: 0.5, // uninformative
            },
          },
          i
        )
      );
    }
    const rec = optimizeWeights(trades);
    expect(rec).not.toBeNull();
    expect(rec!.recommended.momentum).toBeGreaterThan(DEFAULT_WEIGHTS.momentum);
    expect(rec!.recommended.stability).toBeLessThan(DEFAULT_WEIGHTS.stability);
    // total budget preserved (±rounding)
    const total = Object.values(rec!.recommended).reduce((a, b) => a + b, 0);
    const baseTotal = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - baseTotal)).toBeLessThan(1.5);
    // bounded: nothing explodes or vanishes
    for (const [k, v] of Object.entries(rec!.recommended)) {
      const base = DEFAULT_WEIGHTS[k as keyof typeof DEFAULT_WEIGHTS];
      expect(v).toBeGreaterThanOrEqual(base * 0.2);
      expect(v).toBeLessThanOrEqual(base * 2.2);
    }
    const momentumEvidence = rec!.evidence.find((e) => e.metric === "momentum");
    expect(momentumEvidence?.direction).toBe("increase");
  });
});
