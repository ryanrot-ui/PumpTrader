import { describe, expect, it } from "vitest";
import { evaluateExit, trailDistancePct, type OpenPositionView } from "@/engine/trading/exitRules";
import { DEFAULT_SETTINGS } from "@/engine/config";

// Defaults: TP 12 / SL 6 / trail 5 / adaptiveTrailing on / letWinnersRun on /
// cutWeakAfterMinutes 4.

const base = (heldMinutes = 2): OpenPositionView => ({
  entryPriceUsd: 0.001,
  currentPriceUsd: 0.001,
  peakPriceUsd: 0.001,
  openedAt: new Date("2026-07-04T12:00:00Z"),
  now: new Date(new Date("2026-07-04T12:00:00Z").getTime() + heldMinutes * 60_000),
  liquidityDropPct: null,
});

describe("adaptive trailing stop", () => {
  it("uses the full trail below the TP target and tightens it above", () => {
    expect(trailDistancePct(DEFAULT_SETTINGS, 5)).toBe(5);
    expect(trailDistancePct(DEFAULT_SETTINGS, 12)).toBe(3.75); // 0.75×
    expect(trailDistancePct(DEFAULT_SETTINGS, 24)).toBe(2.5); // 0.5×
  });

  it("keeps a fixed trail when adaptiveTrailing is off", () => {
    const s = { ...DEFAULT_SETTINGS, adaptiveTrailing: false };
    expect(trailDistancePct(s, 24)).toBe(5);
  });

  it("fires the tightened trail on a big winner", () => {
    // peak +30% (trail tightens to 2.5%), price falls 3% off peak → exit
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      peakPriceUsd: 0.0013,
      currentPriceUsd: 0.0013 * 0.97,
      buySellRatio5m: 2.5, // strong momentum defers the TP; the trail protects
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("trailing_stop");
  });
});

describe("let winners run (adaptive take profit)", () => {
  it("defers TP while buy pressure is strong", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.00113, // +13% ≥ +12% target
      peakPriceUsd: 0.00113,
      buySellRatio5m: 2.0, // strong
    });
    expect(d.exit).toBe(false); // running behind the trail
  });

  it("takes profit once buy pressure is no longer strong", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.00113,
      peakPriceUsd: 0.00113,
      buySellRatio5m: 1.1,
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("take_profit");
  });

  it("takes profit when flow data is missing (never defers unprotected)", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.00113,
      peakPriceUsd: 0.00113,
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("take_profit");
  });

  it("banks extraordinary spikes at the hard cap even with strong momentum", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(),
      currentPriceUsd: 0.0014, // +40% ≥ 3×12%
      peakPriceUsd: 0.0014,
      buySellRatio5m: 3.0,
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("take_profit");
    expect(d.reason).toContain("runner cap");
  });

  it("honours letWinnersRun=false (classic TP)", () => {
    const s = { ...DEFAULT_SETTINGS, letWinnersRun: false };
    const d = evaluateExit(s, {
      ...base(),
      currentPriceUsd: 0.00113,
      peakPriceUsd: 0.00113,
      buySellRatio5m: 3.0,
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("take_profit");
  });
});

describe("weak-trade cut", () => {
  it("cuts a flat trade with dead buy pressure after the window", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(5), // > 4 min
      currentPriceUsd: 0.001005, // +0.5% — going nowhere
      peakPriceUsd: 0.00101,
      buySellRatio5m: 0.8,
    });
    expect(d.exit).toBe(true);
    expect(d.kind).toBe("weak_exit");
  });

  it("holds inside the window", () => {
    const d = evaluateExit(DEFAULT_SETTINGS, {
      ...base(3),
      currentPriceUsd: 0.001005,
      peakPriceUsd: 0.00101,
      buySellRatio5m: 0.8,
    });
    expect(d.exit).toBe(false);
  });

  it("does not cut while buyers are in control or data is missing", () => {
    expect(
      evaluateExit(DEFAULT_SETTINGS, {
        ...base(5),
        currentPriceUsd: 0.001005,
        peakPriceUsd: 0.00101,
        buySellRatio5m: 1.4,
      }).exit
    ).toBe(false);
    expect(
      evaluateExit({ ...DEFAULT_SETTINGS, maxHoldMinutes: null }, {
        ...base(5),
        currentPriceUsd: 0.001005,
        peakPriceUsd: 0.00101,
      }).exit
    ).toBe(false);
  });

  it("respects cutWeakAfterMinutes=null (disabled)", () => {
    const s = { ...DEFAULT_SETTINGS, cutWeakAfterMinutes: null, maxHoldMinutes: null, exitMinBuySellRatio: null };
    const d = evaluateExit(s, {
      ...base(30),
      currentPriceUsd: 0.001005,
      peakPriceUsd: 0.00101,
      buySellRatio5m: 0.8,
    });
    expect(d.exit).toBe(false);
  });
});
