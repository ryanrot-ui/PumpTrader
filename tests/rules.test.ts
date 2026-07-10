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

describe("evaluateBuyRules — three-layer decision", () => {
  it("buys a token passing safety gates and the score threshold", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.buy).toBe(true);
    expect(d.action).toBe("buy");
    expect(d.reasons[0]).toMatch(/score/);
    expect(d.trace.length).toBeGreaterThan(8);
    expect(d.confidence).toBeGreaterThan(80);
  });

  it("WATCHes (not ignores) a safe token below the score threshold", () => {
    const m = candidate();
    m.topHolderPct = 30; // tanks the score, but not a scam signal
    m.top10HolderPct = 70;
    m.freshWalletPct = 80;
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.buy).toBe(false);
    expect(d.action).toBe("watch");
    expect(d.reasons.some((r) => r.includes("below acceptance threshold"))).toBe(true);
  });

  it("IGNOREs on frozen transfers (safety gate) even with a perfect score", () => {
    const m = candidate();
    m.freezeAuthorityRevoked = false;
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.buy).toBe(false);
    expect(d.action).toBe("ignore");
    expect(d.reasons.some((r) => r.includes("freeze authority"))).toBe(true);
  });

  it("IGNOREs an active mint authority and a suspected honeypot", () => {
    const m = candidate();
    m.mintAuthorityRevoked = false;
    m.isHoneypotSuspected = true;
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.action).toBe("ignore");
    expect(d.reasons.some((r) => r.includes("mint authority"))).toBe(true);
    expect(d.reasons.some((r) => r.includes("honeypot"))).toBe(true);
  });

  it("IGNOREs liquidity below the configurable minimum (unknown fails closed)", () => {
    const m = candidate();
    m.liquiditySol = 10;
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.action).toBe("ignore");
    expect(d.reasons.some((r) => r.includes("liquidity"))).toBe(true);

    const m2 = candidate();
    m2.liquiditySol = null;
    expect(evaluateBuyRules(m2, scoreToken(m2), DEFAULT_SETTINGS).action).toBe("ignore");
  });

  it("does NOT reject on holders/volume/whale/dev/momentum — they become advisories", () => {
    const m = candidate();
    m.holderCount = 20; // below preferred minimum
    m.volume5mUsd = 100; // thin
    m.devWalletPct = 8; // above preferred max
    m.momentum = -0.5; // falling
    const d = evaluateBuyRules(m, scoreToken(m), { ...DEFAULT_SETTINGS, maxDevPct: 5 });
    // Never "ignore" for these: outcome is buy or watch depending on score.
    expect(d.action === "buy" || d.action === "watch").toBe(true);
    expect(d.warnings.some((w) => w.includes("holders"))).toBe(true);
    expect(d.warnings.some((w) => w.includes("volume"))).toBe(true);
    expect(d.warnings.some((w) => w.includes("dev"))).toBe(true);
    expect(d.warnings.some((w) => w.includes("momentum"))).toBe(true);
  });

  it("unknown market cap is an advisory, not a rejection", () => {
    const m = candidate();
    m.marketCapUsd = null;
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.action === "buy" || d.action === "watch").toBe(true);
    expect(d.warnings.some((w) => w.includes("market cap"))).toBe(true);
    expect(d.confidence).toBeLessThan(100);
  });

  it("still enforces the optional liquidity ceiling as a safety gate", () => {
    const m = candidate();
    m.liquiditySol = 900;
    const d = evaluateBuyRules(m, scoreToken(m), { ...DEFAULT_SETTINGS, maxLiquiditySol: 500 });
    expect(d.action).toBe("ignore");
    expect(d.reasons.some((r) => r.includes("maximum"))).toBe(true);
  });

  it("records every rule in the trace with pass/fail and layer", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    for (const r of d.trace) {
      expect(typeof r.passed).toBe("boolean");
      expect(["safety", "opportunity", "risk"]).toContain(r.layer);
      expect(r.detail.length).toBeGreaterThan(0);
    }
    expect(d.trace.some((r) => r.layer === "safety" && r.hard)).toBe(true);
    expect(d.trace.some((r) => r.layer === "risk" && !r.hard)).toBe(true);
  });
});

describe("narrative gates", () => {
  it("no gates configured → narrative optional", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS, null);
    expect(d.buy).toBe(true);
  });

  it("rug-risk gate configured but narrative unavailable → fails closed (safety)", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), { ...DEFAULT_SETTINGS, maxRugRiskScore: 40 }, null);
    expect(d.action).toBe("ignore");
    expect(d.reasons.some((r) => r.includes("rug"))).toBe(true);
  });

  it("high-confidence rug risk over the cap is a hard rejection", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), { ...DEFAULT_SETTINGS, maxRugRiskScore: 40 }, {
      narrativeScore: 80,
      memeScore: 70,
      rugRiskScore: 75,
    });
    expect(d.action).toBe("ignore");
    expect(d.reasons.some((r) => r.includes("rug-risk"))).toBe(true);
  });

  it("narrative/meme minimums are advisories, not rejections", () => {
    const m = candidate();
    const d = evaluateBuyRules(
      m,
      scoreToken(m),
      { ...DEFAULT_SETTINGS, minNarrativeScore: 60, minMemeScore: 50 },
      { narrativeScore: 40, memeScore: 30, rugRiskScore: 20 }
    );
    expect(d.action === "buy" || d.action === "watch").toBe(true);
    expect(d.warnings.some((w) => w.includes("narrative"))).toBe(true);
    expect(d.warnings.some((w) => w.includes("meme"))).toBe(true);
  });

  it("passing narrative appears in the buy reasons", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), { ...DEFAULT_SETTINGS, maxRugRiskScore: 40 }, {
      narrativeScore: 75,
      memeScore: 65,
      rugRiskScore: 25,
    });
    expect(d.buy).toBe(true);
    expect(d.reasons.some((r) => r.includes("narrative 75"))).toBe(true);
  });
});
