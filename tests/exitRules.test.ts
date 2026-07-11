import { describe, expect, it } from "vitest";
import { evaluateExit, type OpenPositionView } from "@/engine/trading/exitRules";
import { DEFAULT_SETTINGS } from "@/engine/config";

// Defaults are now the momentum-scalping preset (TP 12 / SL 6 / trail 5 /
// 10-min max hold / momentum exits on). SWING pins the old-style config so
// the mechanical tests stay explicit about what they exercise.
const SWING = {
  ...DEFAULT_SETTINGS,
  takeProfitPct: 100,
  stopLossPct: 30,
  trailingStopPct: null,
  maxHoldMinutes: null,
  exitMinBuySellRatio: null,
  exitVolumeFadePct: null,
};

const base = (heldMinutes = 2): OpenPositionView => ({
  entryPriceUsd: 0.001,
  currentPriceUsd: 0.001,
  peakPriceUsd: 0.001,
  openedAt: new Date("2026-07-04T12:00:00Z"),
  now: new Date(new Date("2026-07-04T12:00:00Z").getTime() + heldMinutes * 60_000),
  liquidityDropPct: null,
});

describe("evaluateExit — mechanics", () => {
  it("holds when nothing has changed", () => {
    expect(evaluateExit(SWING, base()).exit).toBe(false);
  });

  it("sells at the configured take-profit target", () => {
    const d = evaluateExit(SWING, {
      ...base(),
      currentPriceUsd: 0.002, // +100%
      peakPriceUsd: 0.002,
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("take_profit");
    expect(d.portionPct).toBe(100);
  });

  it("does not take profit just below the target", () => {
    const d = evaluateExit(SWING, {
      ...base(),
      currentPriceUsd: 0.00199, // +99% < +100% target
      peakPriceUsd: 0.00199,
    });
    expect(d.exit).toBe(false);
  });

  it("fires the stop loss at the configured drawdown", () => {
    const d = evaluateExit(SWING, { ...base(), currentPriceUsd: 0.0007 }); // -30%
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("stop_loss");
  });

  it("prioritises the rug exit over everything else", () => {
    const d = evaluateExit(SWING, {
      ...base(),
      currentPriceUsd: 0.0025, // would be TP…
      peakPriceUsd: 0.0025,
      liquidityDropPct: -40, // …but liquidity is draining
    });
    expect(d.kind).toBe("rug_exit");
    expect(d.portionPct).toBe(100);
  });

  it("uses the configurable liquidity-drop threshold", () => {
    const tight = { ...SWING, exitLiquidityDropPct: 10 };
    expect(evaluateExit(tight, { ...base(), liquidityDropPct: -12 }).kind).toBe("rug_exit");
    expect(evaluateExit(SWING, { ...base(), liquidityDropPct: -12 }).exit).toBe(false); // default 25
  });

  it("trails the peak when a trailing stop is configured", () => {
    const settings = { ...SWING, trailingStopPct: 20 };
    const d = evaluateExit(settings, {
      ...base(),
      peakPriceUsd: 0.0018, // +80% peak
      currentPriceUsd: 0.0014, // 22% off peak, still +40%
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("trailing_stop");
  });

  it("never fires the trailing stop while underwater (stop loss owns that)", () => {
    const settings = { ...SWING, trailingStopPct: 10 };
    const d = evaluateExit(settings, {
      ...base(),
      peakPriceUsd: 0.0011,
      currentPriceUsd: 0.00095, // -5% from entry, below peak by >10%
    });
    expect(d.kind).not.toBe("trailing_stop");
    expect(d.exit).toBe(false); // above the -30% stop loss
  });

  it("exits on max hold time when configured", () => {
    const settings = { ...SWING, maxHoldMinutes: 5 };
    const d = evaluateExit(settings, base(10)); // held 10 minutes
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("time_exit");
  });

  it("respects partial take-profit portions", () => {
    const settings = { ...SWING, sellPortionPct: 50 };
    const d = evaluateExit(settings, {
      ...base(),
      currentPriceUsd: 0.0021,
      peakPriceUsd: 0.0021,
    });
    expect(d.exit).toBe(true);
    expect(d.portionPct).toBe(50);
  });
});

describe("evaluateExit — scalping defaults & momentum exits", () => {
  it("takes profit at +12% and cuts losses at -6% by default", () => {
    const tp = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.00113,
      peakPriceUsd: 0.00113,
    });
    expect(tp.kind).toBe("take_profit");
    const sl = evaluateExit(DEFAULT_SETTINGS, { ...base(), currentPriceUsd: 0.00093 });
    expect(sl.kind).toBe("stop_loss");
  });

  it("time-exits at the default 10-minute max hold", () => {
    expect(evaluateExit(DEFAULT_SETTINGS, base(11)).kind).toBe("time_exit");
  });

  it("exits when 5m buy pressure falls below the configured ratio", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.00105, // +5%, not yet TP
      peakPriceUsd: 0.00105,
      buySellRatio5m: 0.5, // sellers dominating
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("momentum_exit");
    expect(d.reason).toMatch(/buy pressure/);
  });

  it("exits when 5m volume fades past the configured percentage", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.00102,
      peakPriceUsd: 0.00105,
      volume5mUsd: 2_000,
      entryVolume5mUsd: 10_000, // -80% ≥ 65% fade limit
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("momentum_exit");
    expect(d.reason).toMatch(/volume faded/);
  });

  it("gives momentum exits a grace period right after entry", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(0.5), // 30s in — inside the 60s grace window
      buySellRatio5m: 0.3,
    });
    expect(d.exit).toBe(false);
  });

  it("momentum exits are disabled when set to null", () => {
    const off = { ...DEFAULT_SETTINGS, exitMinBuySellRatio: null, exitVolumeFadePct: null };
    const d = evaluateExit(off, {
      ...base(),
      buySellRatio5m: 0.2,
      volume5mUsd: 100,
      entryVolume5mUsd: 50_000,
    });
    expect(d.exit).toBe(false);
  });

  it("missing momentum data never triggers an exit (fail-safe hold)", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      buySellRatio5m: null,
      volume5mUsd: null,
      entryVolume5mUsd: null,
    });
    expect(d.exit).toBe(false);
  });
});
