import { describe, expect, it } from "vitest";
import { assessRugRisk } from "../src/engine/narrative/rugRisk";
import type { TokenMetrics } from "../src/engine/analysis/types";

const base = (over: Partial<TokenMetrics> = {}): TokenMetrics => ({
  mint: "TestMint",
  symbol: "TEST",
  name: "Test",
  poolAddress: null,
  migratedAt: new Date(),
  priceUsd: 0.001,
  liquiditySol: 500,
  liquidityUsd: 80_000,
  marketCapUsd: 500_000,
  volume5mUsd: 10_000,
  volume1hUsd: 80_000,
  volumeGrowthPct: 10,
  priceChange5mPct: 2,
  priceChange1hPct: 5,
  txPerMinute: 20,
  buys5m: 60,
  sells5m: 40,
  buySellRatio: 1.5,
  holderCount: 400,
  holderGrowth5m: 10,
  topHolderPct: 4,
  top10HolderPct: 22,
  devWalletPct: 2,
  freshWalletPct: 15,
  sniperWalletCount: 1,
  bundledWalletCount: 1,
  liquidityChangePct: 5,
  estSlippagePctFor1Sol: 0.5,
  volatility5m: 3,
  momentum: 0.5,
  momentumAcceleration: 0.1,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  lpBurnedOrLockedPct: 100,
  isHoneypotSuspected: false,
  devSoldPct: 0,
  washTradingSuspected: false,
  artificialVolumeSuspected: false,
  devReputationScore: null,
  ageSinceMigrationSec: 600,
  missingSources: [],
  ...over,
});

describe("rug risk", () => {
  it("scores a healthy token low", () => {
    const { score } = assessRugRisk(base());
    expect(score).toBeLessThan(30);
  });

  it("scores an obvious danger profile high, with reasons", () => {
    const { score, explanation, factors } = assessRugRisk(
      base({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        lpBurnedOrLockedPct: 0,
        liquidityUsd: 6_000,
        liquidityChangePct: -50,
        top10HolderPct: 75,
        devWalletPct: 30,
        devSoldPct: 60,
        freshWalletPct: 90,
        bundledWalletCount: 25,
        isHoneypotSuspected: true,
        buySellRatio: 0.3,
      })
    );
    expect(score).toBeGreaterThan(80);
    expect(explanation).toContain("Biggest concern");
    expect(factors.every((f) => f.detail.length > 0)).toBe(true);
  });

  it("treats missing data as elevated (not safe, not maximal)", () => {
    const allNull = assessRugRisk(
      base({
        mintAuthorityRevoked: null,
        freezeAuthorityRevoked: null,
        lpBurnedOrLockedPct: null,
        liquidityUsd: null,
        liquidityChangePct: null,
        top10HolderPct: null,
        topHolderPct: null,
        devWalletPct: null,
        devSoldPct: null,
        freshWalletPct: null,
        bundledWalletCount: null,
        isHoneypotSuspected: null,
        washTradingSuspected: null,
        artificialVolumeSuspected: null,
        buySellRatio: null,
      })
    );
    expect(allNull.score).toBe(60);
  });

  it("never claims certainty in the explanation", () => {
    const { explanation } = assessRugRisk(base());
    expect(explanation.toLowerCase()).toContain("estimate");
  });
});
