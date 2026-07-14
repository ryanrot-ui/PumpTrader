import { describe, expect, it } from "vitest";
import { evaluateBuyRules } from "@/engine/trading/rules";
import { scoreToken } from "@/engine/analysis/scoring";
import { emptyMetrics } from "@/engine/analysis/collectors";
import { DEFAULT_SETTINGS } from "@/engine/config";
import { RpcHealthTracker, withRpcRetry, isTimeoutError } from "@/engine/rpc/health";
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
    priceChange5mPct: 8,
    priceChange1hPct: 30,
  });
  return m;
}

describe("entry timing gates (anti-chase)", () => {
  it("buys a fresh, building move", () => {
    const m = candidate();
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.buy).toBe(true);
  });

  it("hard-rejects a vertical 5m candle (chasing)", () => {
    const m = candidate();
    m.priceChange5mPct = 60; // > default 35% cap
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.buy).toBe(false);
    expect(d.action).toBe("ignore");
    expect(d.reasons.join(" ")).toMatch(/chase/i);
  });

  it("hard-rejects an exhausted 1h move", () => {
    const m = candidate();
    m.priceChange1hPct = 300; // > default 175% cap
    const d = evaluateBuyRules(m, scoreToken(m), DEFAULT_SETTINGS);
    expect(d.buy).toBe(false);
    expect(d.action).toBe("ignore");
    expect(d.reasons.join(" ")).toMatch(/exhaustion|already/i);
  });

  it("does not reject when the gates are disabled", () => {
    const m = candidate();
    m.priceChange5mPct = 60;
    m.priceChange1hPct = 300;
    const s = { ...DEFAULT_SETTINGS, maxEntryPriceChange5mPct: null, maxEntryPriceChange1hPct: null };
    const d = evaluateBuyRules(m, scoreToken(m), s);
    // still may be depressed by exhaustion red flags in the score, but no hard gate
    expect(d.action === "buy" || d.action === "watch").toBe(true);
  });

  it("requireRisingMomentum only buys accelerating moves and fails closed on missing data", () => {
    const s = { ...DEFAULT_SETTINGS, requireRisingMomentum: true };
    const building = candidate();
    expect(evaluateBuyRules(building, scoreToken(building), s).buy).toBe(true);

    const fading = candidate();
    fading.momentumAcceleration = -0.5;
    const d = evaluateBuyRules(fading, scoreToken(fading), s);
    expect(d.buy).toBe(false);
    expect(d.action).toBe("ignore");

    const unknown = candidate();
    unknown.momentumAcceleration = null;
    expect(evaluateBuyRules(unknown, scoreToken(unknown), s).buy).toBe(false);
  });

  it("scoring flags exhausted moves as red flags", () => {
    const m = candidate();
    m.priceChange5mPct = 55;
    m.priceChange1hPct = 260;
    const score = scoreToken(m);
    const ids = score.redFlags.map((f) => f.id ?? f.label);
    expect(score.redFlags.some((f) => /vertical|chasing/i.test(f.label))).toBe(true);
    expect(score.redFlags.some((f) => /exhausted/i.test(f.label))).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe("RpcHealthTracker", () => {
  it("scores endpoints down on failures and back up on successes", () => {
    const t = new RpcHealthTracker(["https://a", "https://b"]);
    t.recordFailure("https://a", new Error("Request timeout"));
    t.recordFailure("https://a", new Error("Request timeout"));
    const snap = t.snapshot("https://a");
    expect(snap.rpcHealth).toBeLessThan(50);
    expect(snap.rpcTimeouts).toBe(2);
    t.recordSuccess("https://a", 100);
    expect(t.snapshot("https://a").rpcHealth!).toBeGreaterThan(snap.rpcHealth!);
  });

  it("picks the healthiest alternative for failover and records history", () => {
    const t = new RpcHealthTracker(["https://a", "https://b", "https://c"]);
    t.recordFailure("https://b", new Error("boom"));
    t.recordSuccess("https://c", 80);
    expect(t.bestAlternative("https://a")).toBe("https://c");
    t.recordFailover("https://a", "https://c", "probe failed 3×");
    const snap = t.snapshot("https://c");
    expect(snap.rpcFailoverHistory).toHaveLength(1);
    expect(snap.rpcFailoverHistory[0].to).toBe("https://c");
    expect(snap.rpcEndpoints.find((e) => e.url === "https://c")?.active).toBe(true);
  });

  it("counts consecutive failures and resets on success", () => {
    const t = new RpcHealthTracker(["https://a"]);
    t.recordFailure("https://a", new Error("x"));
    t.recordFailure("https://a", new Error("x"));
    expect(t.consecutiveFailures("https://a")).toBe(2);
    t.recordSuccess("https://a", 50);
    expect(t.consecutiveFailures("https://a")).toBe(0);
  });
});

describe("withRpcRetry", () => {
  it("retries transient failures with backoff and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRpcRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("Request timeout");
        return "ok";
      },
      { retries: 2, baseDelayMs: 1 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry permanent errors", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(
        async () => {
          calls++;
          throw new Error("Invalid param: not a pubkey");
        },
        { retries: 3, baseDelayMs: 1 }
      )
    ).rejects.toThrow(/Invalid param/);
    expect(calls).toBe(1);
  });

  it("classifies timeout errors", () => {
    expect(isTimeoutError(new Error("failed to get signatures for address: Request timeout"))).toBe(true);
    expect(isTimeoutError(new Error("some other failure"))).toBe(false);
  });
});
