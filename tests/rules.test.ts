import { describe, expect, it } from "vitest";
import { evaluateBuyRules } from "@/engine/trading/rules";
import { scoreToken } from "@/engine/analysis/scoring";
import { emptyMetrics } from "@/engine/analysis/collectors";
import { DEFAULT_SETTINGS } from "@/engine/config";
import type { TokenMetrics } from "@/engine/analysis/types";

function candidate(): TokenMetrics {
  const m = emptyMetrics("TESTMINT1111111111111111111111111111111111", new Date(Date.now() - 5 * 60_000));
  Object.assign(m, {
    priceUsd: 0.0001,
    liquiditySol: 250,
    liquidityUsd: 37_500,
    marketCapUsd: 400_000,
    volume5mUsd: 40_000,
    volumeGrowthPct: 60,
    buySellRatio: 2.2,
    buys5m: 200,
    sells5m: 90,
    txPerMinute: 58,
    holderCount: 600,
    holderGrowth5m: 40,
    topHolderPct: 2.5,
    top10HolderPct: 14,
    devWalletPct: 1,
    freshWalletPct: 12,
    sniperWalletCount: 2,
    bundledWalletCount: 0,
    liquidityChangePct: 5,
    estSlippagePctFor1Sol: 0.8,
    volatility5m: 3,
    momentum: 1.2,
    momentumAcceleration: 0.3,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLockedPct: 100,
    isHoneypotSuspected: false,
    devSoldPct: 0,
    washTradingSuspected: false,
    artificialVolumeSuspected: false,
  });
  return m;
}

describe("evaluateBuyRules", () => {
  it("approves a token passing every rule", () => {
    const m = candidate();
    const decision = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(decision.buy).toBe(true);
    expect(decision.reasons[0]).toMatch(/score/);
  });

  it("rejects when score is under the threshold and says why", () => {
    const m = candidate();
    m.topHolderPct = 30; // tank the score
    m.top10HolderPct = 70;
    m.freshWalletPct = 80;
    const decision = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(decision.buy).toBe(false);
    expect(decision.reasons.some((r) => r.includes("below threshold"))).toBe(true);
  });

  it("rejects on any critical red flag even with a perfect score", () => {
    const m = candidate();
    m.freezeAuthorityRevoked = false;
    const decision = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(decision.buy).toBe(false);
    expect(decision.reasons.some((r) => r.includes("critical red flag"))).toBe(true);
  });

  it("rejects when liquidity, holders, or volume are below minimums", () => {
    const m = candidate();
    m.liquiditySol = 10;
    m.holderCount = 20;
    m.volume5mUsd = 100;
    const decision = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(decision.buy).toBe(false);
    expect(decision.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects unknown market cap rather than guessing", () => {
    const m = candidate();
    m.marketCapUsd = null;
    const decision = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(decision.buy).toBe(false);
    expect(decision.reasons.some((r) => r.includes("market cap unknown"))).toBe(true);
  });

  it("rejects falling momentum", () => {
    const m = candidate();
    m.momentum = -0.5;
    const decision = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(decision.buy).toBe(false);
    expect(decision.reasons.some((r) => r.includes("momentum"))).toBe(true);
  });

  it("rejects weak buy pressure below the configurable minimum", () => {
    const m = candidate();
    m.buySellRatio = 1.0;
    const decision = evaluateBuyRules(m, scoreToken(m), { ...DEFAULT_SETTINGS, minBuyPressure: 1.5 });
    expect(decision.buy).toBe(false);
    expect(decision.reasons.some((r) => r.includes("buy pressure"))).toBe(true);
  });

  it("rejects whale and dev concentration over the configured caps", () => {
    const m = candidate();
    m.topHolderPct = 12;
    m.devWalletPct = 8;
    const settings = { ...DEFAULT_SETTINGS, maxWhalePct: 10, maxDevPct: 5 };
    const decision = evaluateBuyRules(m, scoreToken(m), settings);
    expect(decision.buy).toBe(false);
    expect(decision.reasons.some((r) => r.includes("whale"))).toBe(true);
    expect(decision.reasons.some((r) => r.includes("dev holds"))).toBe(true);
  });

  it("rejects liquidity above the optional ceiling", () => {
    const m = candidate();
    m.liquiditySol = 900;
    const decision = evaluateBuyRules(m, scoreToken(m), { ...DEFAULT_SETTINGS, maxLiquiditySol: 500 });
    expect(decision.buy).toBe(false);
    expect(decision.reasons.some((r) => r.includes("above maximum"))).toBe(true);
  });
});

describe("narrative gates", () => {
  const gated = { ...DEFAULT_SETTINGS, minNarrativeScore: 60, minMemeScore: 50, maxRugRiskScore: 40 };

  it("no gates configured → narrative optional", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS, null);
    expect(d.buy).toBe(true);
  });

  it("gates configured but narrative unavailable → fails closed", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), gated, null);
    expect(d.buy).toBe(false);
    expect(d.reasons.some((r) => r.includes("narrative"))).toBe(true);
  });

  it("passing narrative satisfies all gates and appears in the reasons", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), gated, {
      narrativeScore: 75,
      memeScore: 65,
      rugRiskScore: 25,
    });
    expect(d.buy).toBe(true);
    expect(d.reasons.some((r) => r.includes("narrative 75"))).toBe(true);
  });

  it("each failing gate is reported individually", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), gated, {
      narrativeScore: 40,
      memeScore: 30,
      rugRiskScore: 70,
    });
    expect(d.buy).toBe(false);
    expect(d.reasons.filter((r) => /narrative|meme|rug/.test(r)).length).toBe(3);
  });
});
