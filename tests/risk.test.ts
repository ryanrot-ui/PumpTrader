import { describe, expect, it } from "vitest";
import { checkRisk, type RiskState } from "@/engine/trading/riskManager";
import { DEFAULT_SETTINGS } from "@/engine/config";

const cleanState = (): RiskState => ({
  openPositions: 0,
  exposureSol: 0,
  dailyRealizedSol: 0,
  lastLossAt: null,
  emergencyStopped: false,
  now: new Date("2026-07-04T12:00:00Z"),
});

describe("checkRisk", () => {
  it("allows a trade in a clean state and sizes it from settings", () => {
    const d = checkRisk(DEFAULT_SETTINGS, cleanState());
    expect(d.allowed).toBe(true);
    expect(d.sizeSol).toBe(DEFAULT_SETTINGS.buyAmountSol);
  });

  it("blocks when emergency stop is active", () => {
    const d = checkRisk(DEFAULT_SETTINGS, { ...cleanState(), emergencyStopped: true });
    expect(d.allowed).toBe(false);
  });

  it("blocks at max open positions", () => {
    const d = checkRisk(DEFAULT_SETTINGS, {
      ...cleanState(),
      openPositions: DEFAULT_SETTINGS.maxOpenPositions,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/open positions/);
  });

  it("blocks after the daily loss limit is hit", () => {
    const d = checkRisk(DEFAULT_SETTINGS, {
      ...cleanState(),
      dailyRealizedSol: -DEFAULT_SETTINGS.maxDailyLossSol,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/daily loss/);
  });

  it("stops for the day once the profit target is reached", () => {
    const settings = { ...DEFAULT_SETTINGS, dailyProfitTarget: 0.5 };
    const d = checkRisk(settings, { ...cleanState(), dailyRealizedSol: 0.6 });
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/profit target/);
  });

  it("enforces the loss cooldown, then clears it", () => {
    const state = cleanState();
    state.lastLossAt = new Date(state.now!.getTime() - 5 * 60_000); // 5 min ago
    expect(checkRisk(DEFAULT_SETTINGS, state).allowed).toBe(false); // 15 min cooldown

    state.lastLossAt = new Date(state.now!.getTime() - 20 * 60_000); // 20 min ago
    expect(checkRisk(DEFAULT_SETTINGS, state).allowed).toBe(true);
  });

  it("clamps trade size to remaining exposure headroom", () => {
    const settings = { ...DEFAULT_SETTINGS, buyAmountSol: 0.5, maxSolPerTrade: 0.5, maxExposureSol: 1 };
    const d = checkRisk(settings, { ...cleanState(), exposureSol: 0.8, openPositions: 1 });
    expect(d.allowed).toBe(true);
    expect(d.sizeSol).toBeCloseTo(0.2);
  });

  it("blocks entirely when exposure cap is reached", () => {
    const d = checkRisk(DEFAULT_SETTINGS, {
      ...cleanState(),
      exposureSol: DEFAULT_SETTINGS.maxExposureSol,
      openPositions: 1,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes("exposure"))).toBe(true);
  });
});
