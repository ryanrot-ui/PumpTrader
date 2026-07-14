import { describe, expect, it } from "vitest";
import { deriveCauses, deriveTags, type ReviewInput } from "@/engine/learning/review";
import { detectPatterns, MIN_RELEVANT_TRADES } from "@/engine/learning/patterns";
import { compareSettings, type TokenSeries } from "@/engine/backtest/replay";
import { DEFAULT_SETTINGS } from "@/engine/config";
import type { ClosedTrade } from "@/engine/learning/tradeStats";

function review(overrides: Partial<ReviewInput>): ReviewInput {
  return {
    positionId: "pos1",
    mint: "MINT1111",
    symbol: "TEST",
    paper: true,
    pnlSol: -0.01,
    pnlPct: -9,
    holdMinutes: 4,
    exitReason: "stop loss: -9.0% ≤ -6%",
    exitKind: "stop_loss",
    maxUnrealizedPnlPct: 0.5,
    maxDrawdownPct: -9,
    takeProfitPct: 12,
    stopLossPct: 6,
    entrySignals: {
      scannerScore: 78,
      context: {
        liquiditySol: 18,
        buySellRatio: 1.1,
        momentumAcceleration: -0.4,
        priceChange5mPct: 28,
        priceChange1hPct: 60,
        volatility5m: 8,
        estSlippagePctFor1Sol: 1.0,
        holderCount: 300,
        tokenAgeMin: 6,
        detectionToBuyMs: 15_000,
      },
    },
    ...overrides,
  };
}

describe("trade review — cause attribution", () => {
  it("attributes a chased stop-loss with ranked confidences", () => {
    const causes = deriveCauses(review({}));
    expect(causes.length).toBeGreaterThanOrEqual(3);
    // ranked by confidence
    for (let i = 1; i < causes.length; i++) {
      expect(causes[i].confidencePct).toBeLessThanOrEqual(causes[i - 1].confidencePct);
    }
    const names = causes.map((c) => c.cause);
    expect(names).toContain("momentum already fading at entry");
    expect(names).toContain("entered too late");
    expect(names).toContain("liquidity too low"); // 18 SOL contributing factor
    expect(causes.every((c) => c.confidencePct >= 0 && c.confidencePct <= 100)).toBe(true);
  });

  it("attributes rug exits and momentum exits to their causes", () => {
    const rug = deriveCauses(
      review({ exitKind: "rug_exit", exitReason: "liquidity dropped -40% — emergency exit" })
    );
    expect(rug[0].cause).toBe("whale dumped / liquidity pulled");
    expect(rug[0].confidencePct).toBeGreaterThanOrEqual(85);

    const mom = deriveCauses(
      review({ exitKind: "momentum_exit", exitReason: "buy pressure faded: 5m buy/sell 0.6 < 0.75" })
    );
    expect(mom[0].cause).toBe("buy pressure disappeared");
  });

  it("distinguishes reversal-after-gain from never-worked", () => {
    const reversed = deriveCauses(review({ maxUnrealizedPnlPct: 8 }));
    expect(reversed.map((c) => c.cause)).toContain("market reversal");
    expect(reversed.map((c) => c.cause)).not.toContain("fake breakout");
  });

  it("falls back to unknown when nothing explains the loss", () => {
    const causes = deriveCauses(
      review({
        exitKind: "other",
        exitReason: "manual close",
        entrySignals: { scannerScore: 90, context: { liquiditySol: 200, buySellRatio: 2.5 } },
        takeProfitPct: 12,
        stopLossPct: 6,
      })
    );
    expect(causes[0].cause).toBe("unknown");
  });

  it("explains winners too", () => {
    const causes = deriveCauses(
      review({ pnlSol: 0.02, pnlPct: 13, exitKind: "take_profit", exitReason: "take profit: +13% ≥ +12%", maxUnrealizedPnlPct: 14 })
    );
    expect(causes[0].cause).toBe("target reached");
  });

  it("derives objective condition tags for wins and losses alike", () => {
    const tags = deriveTags(review({}));
    expect(tags).toContain("late_entry"); // +28%/5m
    expect(tags).toContain("liquidity_under_25_sol");
    expect(tags).toContain("momentum_decelerating");
    expect(tags).toContain("weak_buy_pressure");
    expect(tags).not.toContain("score_85_plus");
  });
});

// ── pattern detection ────────────────────────────────────────────────────────

const T0 = new Date("2026-07-01T10:00:00Z").getTime();

function trade(i: number, win: boolean, liquidity: number): ClosedTrade {
  const openedAt = new Date(T0 + i * 600_000);
  return {
    pnlSol: win ? 0.02 : -0.015,
    pnlPct: win ? 15 : -8,
    entrySol: 0.1,
    openedAt,
    closedAt: new Date(openedAt.getTime() + 5 * 60_000),
    exitReason: null,
    exitKind: win ? "take_profit" : "stop_loss",
    entryReason: null,
    score: 75,
    entryMarketCapUsd: 150_000,
    entryLiquiditySol: liquidity,
    tokenAgeMinAtEntry: 5,
    detectionToBuyMs: 4_000,
    maxUnrealizedPnlPct: null,
    maxDrawdownPct: null,
    entryMetrics: null,
    entryContext: { buySellRatio: 1.5 },
    paper: true,
  };
}

describe("pattern detection — safe learning gates", () => {
  it("recommends raising min liquidity when low-liquidity trades significantly lose", () => {
    const trades: ClosedTrade[] = [];
    // 60 trades ≥50 SOL: 65% WR; 40 trades <25 SOL: 15% WR
    for (let i = 0; i < 60; i++) trades.push(trade(i, i % 20 < 13, 80));
    for (let i = 60; i < 100; i++) trades.push(trade(i, i % 20 < 3, 18));
    const report = detectPatterns(trades, DEFAULT_SETTINGS);
    const rec = report.recommendations.find((r) => r.parameter === "minLiquiditySol");
    expect(rec).toBeDefined();
    expect(rec!.proposed).toBeGreaterThan(DEFAULT_SETTINGS.minLiquiditySol);
    expect(rec!.evidence.confidencePct).toBeGreaterThanOrEqual(95);
    expect(rec!.evidence.expectedWinRateDeltaPct).toBeGreaterThan(0);
    expect(rec!.evidence.filteredPnlSol).toBeLessThan(0);
    // descriptive finding also surfaces the winner/loser difference
    expect(report.findings.some((f) => f.characteristic.includes("liquidity"))).toBe(true);
  });

  it("stays silent below the minimum sample size", () => {
    const trades: ClosedTrade[] = [];
    for (let i = 0; i < MIN_RELEVANT_TRADES - 1; i++) trades.push(trade(i, i % 2 === 0, i < 25 ? 18 : 80));
    const report = detectPatterns(trades, DEFAULT_SETTINGS);
    expect(report.recommendations).toHaveLength(0);
  });

  it("does not chase noise (no significant difference → no recommendation)", () => {
    const trades: ClosedTrade[] = [];
    // 50/50 outcomes on both sides of every cutoff
    for (let i = 0; i < 120; i++) trades.push(trade(i, i % 2 === 0, i % 4 < 2 ? 18 : 80));
    const report = detectPatterns(trades, DEFAULT_SETTINGS);
    expect(report.recommendations.find((r) => r.parameter === "minLiquiditySol")).toBeUndefined();
  });

  it("computes a bounded strategy confidence", () => {
    const trades: ClosedTrade[] = [];
    for (let i = 0; i < 100; i++) trades.push(trade(i, i % 5 < 3, 80)); // 60% WR, PF > 1
    const report = detectPatterns(trades, DEFAULT_SETTINGS);
    expect(report.strategyConfidence).toBeGreaterThan(40);
    expect(report.strategyConfidence).toBeLessThanOrEqual(100);
  });
});

// ── backtest-first comparison ────────────────────────────────────────────────

function series(prices: number[], score: number): TokenSeries {
  return {
    mint: `SIM${score}`,
    migratedAt: new Date(T0),
    detectedAt: new Date(T0 + 5_000),
    points: prices.map((priceUsd, i) => ({
      at: new Date(T0 + 2 * 60_000 + i * 15_000),
      priceUsd,
      liquiditySol: 100,
      volume5mUsd: 20_000,
      buySellRatio: 1.2,
      marketCapUsd: 150_000,
      score,
    })),
  };
}

describe("compareSettings (backtest first)", () => {
  it("replays both parameter sets and reports whether the proposal improves", () => {
    // score-72 token dumps; score-90 token pumps. Raising the threshold to 85
    // skips the loser and keeps the winner.
    const data = [
      series([0.001, 0.001, 0.0009], 72), // -10% → stop loss
      series([0.001, 0.001, 0.00105, 0.00115], 90), // +15% → TP
    ];
    const current = { ...DEFAULT_SETTINGS, confidenceThreshold: 70, letWinnersRun: false, cutWeakAfterMinutes: null };
    const proposed = { ...current, confidenceThreshold: 85 };
    const cmp = compareSettings(data, current, proposed);
    expect(cmp.current.trades).toBe(2);
    expect(cmp.proposed.trades).toBe(1);
    expect(cmp.proposed.totalPnlSol).toBeGreaterThan(cmp.current.totalPnlSol);
    expect(cmp.improves).toBe(true);
    expect(cmp.verdict).toMatch(/safe to apply/);

    // and the reverse direction is rejected
    const worse = compareSettings(data, proposed, current);
    expect(worse.improves).toBe(false);
  });
});
