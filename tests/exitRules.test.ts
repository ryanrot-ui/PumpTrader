import { describe, expect, it } from "vitest";
import { evaluateExit, type OpenPositionView } from "@/engine/trading/exitRules";
import { DEFAULT_SETTINGS } from "@/engine/config";

const base = (): OpenPositionView => ({
  entryPriceUsd: 0.001,
  currentPriceUsd: 0.001,
  peakPriceUsd: 0.001,
  openedAt: new Date("2026-07-04T12:00:00Z"),
  now: new Date("2026-07-04T12:10:00Z"),
  liquidityDropPct: null,
});

describe("evaluateExit", () => {
  it("holds when nothing has changed", () => {
    expect(evaluateExit(DEFAULT_SETTINGS, base()).exit).toBe(false);
  });

  it("sells the entire position at exactly +100% by default", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.002, // +100%
      peakPriceUsd: 0.002,
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("take_profit");
    expect(d.portionPct).toBe(100);
  });

  it("does not take profit at +99%", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.00199,
      peakPriceUsd: 0.00199,
    });
    expect(d.exit).toBe(false);
  });

  it("fires the stop loss at the configured drawdown", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.0007, // -30%
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("stop_loss");
  });

  it("prioritises the rug exit over everything else", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.0025, // would be TP…
      peakPriceUsd: 0.0025,
      liquidityDropPct: -40, // …but liquidity is draining
    });
    expect(d.kind).toBe("rug_exit");
    expect(d.portionPct).toBe(100);
  });

  it("trails the peak when a trailing stop is configured", () => {
    const settings = { ...DEFAULT_SETTINGS, trailingStopPct: 20 };
    const d = evaluateExit(settings, {
      ...base(),
      peakPriceUsd: 0.0018, // +80% peak
      currentPriceUsd: 0.0014, // 22% off peak, still +40%
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("trailing_stop");
  });

  it("never fires the trailing stop while underwater (stop loss owns that)", () => {
    const settings = { ...DEFAULT_SETTINGS, trailingStopPct: 10 };
    const d = evaluateExit(settings, {
      ...base(),
      peakPriceUsd: 0.0011,
      currentPriceUsd: 0.00095, // -5% from entry, below peak by >10%
    });
    expect(d.kind).not.toBe("trailing_stop");
    expect(d.exit).toBe(false); // above the -30% stop loss
  });

  it("exits on max hold time when configured", () => {
    const settings = { ...DEFAULT_SETTINGS, maxHoldMinutes: 5 };
    const d = evaluateExit(settings, base()); // held 10 minutes
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("time_exit");
  });

  it("respects partial take-profit portions", () => {
    const settings = { ...DEFAULT_SETTINGS, sellPortionPct: 50 };
    const d = evaluateExit(settings, {
      ...base(),
      currentPriceUsd: 0.0021,
      peakPriceUsd: 0.0021,
    });
    expect(d.exit).toBe(true);
    expect(d.portionPct).toBe(50);
  });
});
