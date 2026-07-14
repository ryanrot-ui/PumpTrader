import { describe, expect, it } from "vitest";
import {
  analyzeSimilarity,
  lessonDelta,
  preTradeReview,
  tagsForSetup,
  MAX_BONUS,
  MAX_PENALTY,
  MIN_TAG_TRADES,
  type SetupFeatures,
} from "@/engine/learning/preTrade";
import type { ClosedTrade } from "@/engine/learning/tradeStats";

const T0 = new Date("2026-07-01T10:00:00Z").getTime();

function setup(over: Partial<SetupFeatures> = {}): SetupFeatures {
  return {
    scannerScore: 78,
    narrativeScore: null,
    liquiditySol: 80,
    marketCapUsd: 150_000,
    volume5mUsd: 20_000,
    buySellRatio: 1.6,
    momentum: 1.0,
    momentumAcceleration: 0.3,
    volatility5m: 6,
    estSlippagePctFor1Sol: 0.8,
    holderCount: 300,
    tokenAgeMin: 6,
    priceChange5mPct: 8,
    priceChange1hPct: 30,
    regime: "bull_trend",
    ...over,
  };
}

function historyTrade(i: number, win: boolean, like: Partial<SetupFeatures> = {}): ClosedTrade {
  const s = setup(like);
  const openedAt = new Date(T0 + i * 600_000);
  return {
    pnlSol: win ? 0.02 : -0.015,
    pnlPct: win ? 14 : -7,
    entrySol: 0.1,
    openedAt,
    closedAt: new Date(openedAt.getTime() + 5 * 60_000),
    exitReason: null,
    exitKind: win ? "take_profit" : "stop_loss",
    entryReason: null,
    score: s.scannerScore,
    entryMarketCapUsd: s.marketCapUsd,
    entryLiquiditySol: s.liquiditySol,
    tokenAgeMinAtEntry: s.tokenAgeMin,
    detectionToBuyMs: 4_000,
    maxUnrealizedPnlPct: null,
    maxDrawdownPct: null,
    entryMetrics: null,
    entryContext: {
      buySellRatio: s.buySellRatio,
      momentum: s.momentum,
      momentumAcceleration: s.momentumAcceleration,
      volume5mUsd: s.volume5mUsd,
      holderCount: s.holderCount,
      volatility5m: s.volatility5m,
      estSlippagePctFor1Sol: s.estSlippagePctFor1Sol,
      priceChange5mPct: s.priceChange5mPct,
      priceChange1hPct: s.priceChange1hPct,
    },
    paper: true,
  };
}

describe("lesson deltas (bounded, asymmetric)", () => {
  it("penalizes poor-win-rate conditions harder than it rewards good ones", () => {
    expect(lessonDelta(22)).toBeLessThanOrEqual(-12); // "liquidity under X: 22% WR"
    expect(lessonDelta(22)).toBeGreaterThanOrEqual(-15);
    expect(lessonDelta(68)).toBeGreaterThanOrEqual(6); // "accel strong: 68% WR"
    expect(lessonDelta(68)).toBeLessThanOrEqual(8);
    expect(lessonDelta(50)).toBe(0);
    expect(lessonDelta(0)).toBe(-15); // hard floor
    expect(lessonDelta(100)).toBe(8); // hard ceiling
  });
});

describe("similarity analysis (k-NN)", () => {
  it("recognizes a setup that resembles past winners", () => {
    const history: ClosedTrade[] = [];
    // 20 near-identical setups that mostly won + 20 very different ones
    for (let i = 0; i < 20; i++) history.push(historyTrade(i, i % 10 < 7));
    for (let i = 20; i < 40; i++)
      history.push(historyTrade(i, false, { liquiditySol: 15, buySellRatio: 0.8, volatility5m: 25, scannerScore: 62, tokenAgeMin: 40, momentum: -0.5, volume5mUsd: 2_000, holderCount: 40, marketCapUsd: 30_000 }));
    const sim = analyzeSimilarity(setup(), history);
    expect(sim.verdict).toBe("resembles_winners");
    expect(sim.winRate).toBeGreaterThanOrEqual(60);
    expect(sim.neighbours).toBeGreaterThanOrEqual(8);
  });

  it("recognizes a setup that resembles past losers", () => {
    const history: ClosedTrade[] = [];
    for (let i = 0; i < 25; i++) history.push(historyTrade(i, i % 10 < 2)); // 20% WR twins
    const sim = analyzeSimilarity(setup(), history);
    expect(sim.verdict).toBe("resembles_losers");
  });

  it("returns unknown when nothing similar exists", () => {
    const history: ClosedTrade[] = [];
    for (let i = 0; i < 25; i++)
      history.push(historyTrade(i, true, { liquiditySol: 8, buySellRatio: 0.5, volatility5m: 40, scannerScore: 55, tokenAgeMin: 44, momentum: -2, volume5mUsd: 800, holderCount: 25, marketCapUsd: 20_000, estSlippagePctFor1Sol: 6 }));
    const sim = analyzeSimilarity(setup(), history);
    expect(sim.verdict).toBe("unknown");
    expect(analyzeSimilarity(setup(), []).verdict).toBe("unknown");
  });
});

describe("preTradeReview (the full pre-buy learning pass)", () => {
  const lessons = [
    { tag: "liquidity_over_50_sol", trades: 60, winRate: 61 },
    { tag: "momentum_accelerating", trades: 45, winRate: 68 },
    { tag: "regime_bull_trend", trades: 80, winRate: 58 },
    { tag: "late_entry", trades: 40, winRate: 22 },
    { tag: "few_holders", trades: 5, winRate: 0 }, // below MIN_TAG_TRADES → ignored
  ];

  it("applies lesson bonuses for conditions that historically won", () => {
    const history = Array.from({ length: 30 }, (_, i) => historyTrade(i, i % 10 < 7));
    const r = preTradeReview(setup({ momentumAcceleration: 0.8 }), history, lessons);
    expect(r.scoreDelta).toBeGreaterThan(0);
    expect(r.scoreDelta).toBeLessThanOrEqual(MAX_BONUS);
    expect(r.lessonsApplied.map((l) => l.tag)).toContain("momentum_accelerating");
    expect(r.lessonsApplied.map((l) => l.tag)).not.toContain("few_holders"); // insufficient sample
    expect(r.sizeMultiplier).toBe(1);
    expect(r.summary).toMatch(/resembles winners/);
  });

  it("applies penalties when the setup carries losing conditions", () => {
    const history = Array.from({ length: 30 }, (_, i) => historyTrade(i, i % 10 < 2));
    const r = preTradeReview(setup({ priceChange5mPct: 28 }), history, lessons); // late_entry tag
    expect(r.scoreDelta).toBeLessThan(0);
    expect(r.scoreDelta).toBeGreaterThanOrEqual(MAX_PENALTY);
    expect(r.lessonsApplied.find((l) => l.tag === "late_entry")!.delta).toBeLessThanOrEqual(-12);
    expect(r.summary).toMatch(/resembles losers/);
  });

  it("halves size for unknown patterns instead of assuming they're good", () => {
    const distant = Array.from({ length: 30 }, (_, i) =>
      historyTrade(i, true, { liquiditySol: 8, buySellRatio: 0.5, volatility5m: 40, scannerScore: 55, tokenAgeMin: 44, momentum: -2, volume5mUsd: 800, holderCount: 25, marketCapUsd: 20_000, estSlippagePctFor1Sol: 6 })
    );
    const r = preTradeReview(setup(), distant, []);
    expect(r.similarity.verdict).toBe("unknown");
    expect(r.sizeMultiplier).toBe(0.5);
  });

  it("derives the same condition tags the post-trade reviews use", () => {
    const tags = tagsForSetup(setup({ liquiditySol: 18, priceChange5mPct: 30, regime: "pump_mania" }));
    expect(tags).toContain("liquidity_under_25_sol");
    expect(tags).toContain("late_entry");
    expect(tags).toContain("regime_pump_mania");
  });

  it("caps the combined adjustment even when many lessons stack", () => {
    const awful = [
      { tag: "late_entry", trades: 100, winRate: 10 },
      { tag: "liquidity_under_25_sol", trades: 100, winRate: 12 },
      { tag: "weak_buy_pressure", trades: 100, winRate: 15 },
      { tag: "high_volatility", trades: 100, winRate: 18 },
      { tag: "regime_bear_trend", trades: 100, winRate: 20 },
    ];
    const history = Array.from({ length: 30 }, (_, i) => historyTrade(i, false));
    const r = preTradeReview(
      setup({ liquiditySol: 18, priceChange5mPct: 30, buySellRatio: 0.9, volatility5m: 20, regime: "bear_trend" }),
      history,
      awful
    );
    expect(r.scoreDelta).toBe(MAX_PENALTY); // bounded, never unbounded stacking
  });

  it("MIN_TAG_TRADES guards against tiny samples", () => {
    expect(MIN_TAG_TRADES).toBeGreaterThanOrEqual(20);
  });
});
