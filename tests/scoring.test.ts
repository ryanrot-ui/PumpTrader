import { describe, expect, it } from "vitest";
import { scoreToken } from "@/engine/analysis/scoring";
import { emptyMetrics } from "@/engine/analysis/collectors";
import type { TokenMetrics } from "@/engine/analysis/types";

function healthyToken(): TokenMetrics {
  const m = emptyMetrics("TESTMINT1111111111111111111111111111111111", new Date(Date.now() - 5 * 60_000));
  Object.assign(m, {
    priceUsd: 0.0001,
    liquiditySol: 250,
    liquidityUsd: 37_500,
    marketCapUsd: 400_000,
    volume5mUsd: 40_000,
    volumeGrowthPct: 60,
    buys5m: 200,
    sells5m: 90,
    buySellRatio: 200 / 90,
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
  } satisfies Partial<TokenMetrics>);
  return m;
}

describe("scoreToken", () => {
  it("scores a healthy token above the default 85 threshold", () => {
    const result = scoreToken(healthyToken());
    expect(result.total).toBeGreaterThanOrEqual(85);
    expect(result.criticalFlags).toHaveLength(0);
    expect(result.greenFlags.length).toBeGreaterThanOrEqual(8);
  });

  it("caps missing-data tokens well below the buy threshold", () => {
    const m = emptyMetrics("UNKNOWN11111111111111111111111111111111111", new Date());
    const result = scoreToken(m);
    // all-neutral base is 50, green bonus 0 → nowhere near 85
    expect(result.total).toBeLessThan(60);
    expect(result.greenFlags).toHaveLength(0);
  });

  it("flags active freeze authority as critical", () => {
    const m = healthyToken();
    m.freezeAuthorityRevoked = false;
    const result = scoreToken(m);
    expect(result.criticalFlags.map((f) => f.id)).toContain("freeze_active");
    expect(result.total).toBeLessThan(85);
  });

  it("flags honeypot as critical and collapses the score", () => {
    const m = healthyToken();
    m.isHoneypotSuspected = true;
    const result = scoreToken(m);
    expect(result.criticalFlags.map((f) => f.id)).toContain("honeypot");
    // critical flags block buying regardless; the 100-point penalty also
    // collapses even a perfect base score
    expect(result.total).toBeLessThanOrEqual(10);
  });

  it("flags liquidity removal as critical", () => {
    const m = healthyToken();
    m.liquidityChangePct = -45;
    const result = scoreToken(m);
    expect(result.criticalFlags.map((f) => f.id)).toContain("liquidity_removal");
  });

  it("flags developer dumping as critical", () => {
    const m = healthyToken();
    m.devSoldPct = 75;
    const result = scoreToken(m);
    expect(result.criticalFlags.map((f) => f.id)).toContain("dev_dumping");
  });

  it("penalises whale concentration without marking it critical", () => {
    const clean = scoreToken(healthyToken());
    const m = healthyToken();
    m.topHolderPct = 25;
    const result = scoreToken(m);
    expect(result.total).toBeLessThan(clean.total);
    expect(result.redFlags.map((f) => f.id)).toContain("whale_concentration");
    expect(result.criticalFlags.map((f) => f.id)).not.toContain("whale_concentration");
  });

  it("penalises artificial volume and wash trading", () => {
    const m = healthyToken();
    m.artificialVolumeSuspected = true;
    m.washTradingSuspected = true;
    const result = scoreToken(m);
    const ids = result.redFlags.map((f) => f.id);
    expect(ids).toContain("artificial_volume");
    expect(ids).toContain("wash_trading");
  });

  it("always explains its result", () => {
    const result = scoreToken(healthyToken());
    expect(result.explanation).toMatch(/weighted metrics/);
    expect(result.metrics.length).toBeGreaterThan(10);
    for (const ms of result.metrics) {
      expect(ms.value).toBeGreaterThanOrEqual(0);
      expect(ms.value).toBeLessThanOrEqual(1);
    }
  });
});
