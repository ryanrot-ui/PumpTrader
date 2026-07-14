import { describe, expect, it } from "vitest";
import { simulateToken, runBacktest, type TokenSeries } from "@/engine/backtest/replay";
import { DEFAULT_SETTINGS } from "@/engine/config";
import { PRESETS } from "@/lib/presets";
import type { BotSettings } from "@/lib/validation";

const T0 = new Date("2026-07-05T12:00:00Z").getTime();

/** Build a series: prices sampled every 15s starting 2 min after migration. */
function series(prices: Array<number | null>, score = 90): TokenSeries {
  return {
    mint: "SIM111",
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

const settings: BotSettings = {
  ...DEFAULT_SETTINGS,
  confidenceThreshold: 70,
  letWinnersRun: false, // deterministic TP for the test
  cutWeakAfterMinutes: null,
};

describe("backtest replay", () => {
  it("enters at the first qualifying snapshot and exits at take profit", () => {
    // +15% two points after entry → TP at +12%
    const t = simulateToken(series([0.001, 0.001, 0.00105, 0.00115]), settings);
    expect(t).not.toBeNull();
    expect(t!.pnlPct).toBeGreaterThan(12);
    expect(t!.exitKind).toBe("take_profit");
    expect(t!.pnlSol).toBeGreaterThan(0);
  });

  it("exits at the stop loss on a dump", () => {
    const t = simulateToken(series([0.001, 0.001, 0.00092]), settings);
    expect(t).not.toBeNull();
    expect(t!.exitKind).toBe("stop_loss");
    expect(t!.pnlSol).toBeLessThan(0);
  });

  it("skips tokens that never reach the threshold", () => {
    const t = simulateToken(series([0.001, 0.001, 0.002], 40), settings);
    expect(t).toBeNull();
  });

  it("closes at data end when the series finishes while open", () => {
    const t = simulateToken(series([0.001, 0.001, 0.00101]), settings);
    expect(t).not.toBeNull();
    expect(t!.exitKind).toBe("data_end");
  });

  it("compares all presets over the same series", () => {
    const data = [series([0.001, 0.001, 0.00105, 0.00115, 0.0012, 0.001])];
    const results = runBacktest(data, PRESETS);
    expect(results).toHaveLength(PRESETS.length);
    for (const r of results) {
      expect(r.tokensConsidered).toBe(1);
      expect(r.stats).toBeDefined();
    }
    // the aggressive profile (threshold 60) must trade at least as often as
    // the conservative one (threshold 85) on identical data
    const agg = results.find((r) => r.preset === "aggressive")!;
    const cons = results.find((r) => r.preset === "conservative")!;
    expect(agg.trades).toBeGreaterThanOrEqual(cons.trades);
  });
});
