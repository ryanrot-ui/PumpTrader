import type { FlagResult, MetricScore, ScoreResult, TokenMetrics } from "./types";

/**
 * Configurable weighted scoring engine.
 *
 * Each metric maps its raw value onto a 0..1 quality score, which is combined
 * using the weights below into a 0..100 confidence score. Missing data scores
 * a neutral 0.5 so an information-poor token can never reach the top of the
 * range on absence of evidence alone.
 *
 * Nothing here predicts profit. The score ranks how closely a token matches
 * a configurable "healthy launch" profile; every contribution is recorded and
 * surfaced in the UI so users can see exactly why a token scored what it did.
 */

export interface ScoringWeights {
  liquidity: number;
  marketCap: number;
  volume: number;
  volumeGrowth: number;
  buyPressure: number;
  holders: number;
  holderGrowth: number;
  distribution: number; // top holder / top10 / dev %
  walletQuality: number; // fresh wallets, snipers, bundles
  momentum: number;
  stability: number; // liquidity stability, volatility, slippage
  safety: number; // authorities, LP lock, honeypot, dev behaviour
  activity: number; // tx velocity
}

/**
 * Momentum-scalping weights: the score measures the best setup RIGHT NOW,
 * not "the best coin". Live demand signals (buy pressure, momentum, volume
 * acceleration, holder growth, activity) carry ~68 of 100 points; static
 * quality (liquidity depth, distribution, wallet quality) provides the
 * floor; safety weighs less here because outright scam conditions are
 * enforced by the hard safety gates in trading/rules.ts, not by the score.
 * All weights remain overridable per-user via settings.scoringWeights.
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  liquidity: 8,
  marketCap: 1,
  volume: 10,
  volumeGrowth: 12,
  buyPressure: 14,
  holders: 1,
  holderGrowth: 10,
  distribution: 8,
  walletQuality: 6,
  momentum: 14,
  stability: 2,
  safety: 6,
  activity: 8,
};

// ── helpers ─────────────────────────────────────────────────────────────────

/** Linear ramp: 0 below lo, 1 above hi. */
const ramp = (v: number, lo: number, hi: number) =>
  Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

/** 1 inside [lo,hi], falling to 0 at the outer bounds. */
const band = (v: number, outerLo: number, lo: number, hi: number, outerHi: number) => {
  if (v >= lo && v <= hi) return 1;
  if (v < lo) return Math.max(0, (v - outerLo) / (lo - outerLo));
  return Math.max(0, (outerHi - v) / (outerHi - hi));
};

const NEUTRAL = 0.5;

function scoreOrNeutral<T>(
  raw: T | null,
  fn: (v: T) => { value: number; detail: string },
  missingDetail: string
): { value: number; detail: string } {
  if (raw === null || raw === undefined) return { value: NEUTRAL, detail: missingDetail };
  return fn(raw);
}

// ── metric scorers ──────────────────────────────────────────────────────────

function buildMetricScores(m: TokenMetrics, w: ScoringWeights): MetricScore[] {
  const entries: Array<{ metric: string; weight: number; s: { value: number; detail: string } }> = [
    {
      metric: "liquidity",
      weight: w.liquidity,
      s: scoreOrNeutral(m.liquiditySol, (v) => ({
        value: ramp(v, 20, 300),
        detail: `${v.toFixed(1)} SOL pooled`,
      }), "liquidity unknown"),
    },
    {
      metric: "marketCap",
      weight: w.marketCap,
      s: scoreOrNeutral(m.marketCapUsd, (v) => ({
        value: band(v, 20_000, 60_000, 1_000_000, 5_000_000),
        detail: `$${Math.round(v).toLocaleString()} mcap`,
      }), "market cap unknown"),
    },
    {
      metric: "volume",
      weight: w.volume,
      s: scoreOrNeutral(m.volume5mUsd, (v) => ({
        value: ramp(v, 2_000, 50_000),
        detail: `$${Math.round(v).toLocaleString()} 5m volume`,
      }), "volume unknown"),
    },
    {
      metric: "volumeGrowth",
      weight: w.volumeGrowth,
      s: scoreOrNeutral(m.volumeGrowthPct, (v) => ({
        value: ramp(v, -20, 100),
        detail: `${v.toFixed(0)}% 5m volume growth`,
      }), "volume trend unknown"),
    },
    {
      metric: "buyPressure",
      weight: w.buyPressure,
      s: scoreOrNeutral(m.buySellRatio, (v) => ({
        value: band(v, 0.5, 1.2, 3.5, 8), // extreme ratios look manufactured
        detail: `buy/sell ratio ${v.toFixed(2)}`,
      }), "buy pressure unknown"),
    },
    {
      metric: "holders",
      weight: w.holders,
      s: scoreOrNeutral(m.holderCount, (v) => ({
        value: ramp(v, 80, 800),
        detail: `${v} holders`,
      }), "holder count unknown"),
    },
    {
      metric: "holderGrowth",
      weight: w.holderGrowth,
      s: scoreOrNeutral(m.holderGrowth5m, (v) => ({
        value: ramp(v, 0, 60),
        detail: `${v} new holders / 5m`,
      }), "holder growth unknown"),
    },
    {
      metric: "distribution",
      weight: w.distribution,
      s: (() => {
        const parts: number[] = [];
        const details: string[] = [];
        if (m.topHolderPct !== null) {
          parts.push(1 - ramp(m.topHolderPct, 3, 15));
          details.push(`top holder ${m.topHolderPct.toFixed(1)}%`);
        }
        if (m.top10HolderPct !== null) {
          parts.push(1 - ramp(m.top10HolderPct, 15, 50));
          details.push(`top10 ${m.top10HolderPct.toFixed(1)}%`);
        }
        if (m.devWalletPct !== null) {
          parts.push(1 - ramp(m.devWalletPct, 2, 10));
          details.push(`dev holds ${m.devWalletPct.toFixed(1)}%`);
        }
        if (parts.length === 0) return { value: NEUTRAL, detail: "distribution unknown" };
        return {
          value: parts.reduce((a, b) => a + b, 0) / parts.length,
          detail: details.join(", "),
        };
      })(),
    },
    {
      metric: "walletQuality",
      weight: w.walletQuality,
      s: (() => {
        const parts: number[] = [];
        const details: string[] = [];
        if (m.freshWalletPct !== null) {
          parts.push(1 - ramp(m.freshWalletPct, 25, 70));
          details.push(`${m.freshWalletPct.toFixed(0)}% fresh wallets`);
        }
        if (m.sniperWalletCount !== null) {
          parts.push(1 - ramp(m.sniperWalletCount, 3, 20));
          details.push(`${m.sniperWalletCount} snipers`);
        }
        if (m.bundledWalletCount !== null) {
          parts.push(1 - ramp(m.bundledWalletCount, 2, 12));
          details.push(`${m.bundledWalletCount} bundled wallets`);
        }
        if (parts.length === 0) return { value: NEUTRAL, detail: "wallet quality unknown" };
        return {
          value: parts.reduce((a, b) => a + b, 0) / parts.length,
          detail: details.join(", "),
        };
      })(),
    },
    {
      metric: "momentum",
      weight: w.momentum,
      s: (() => {
        if (m.momentum === null) return { value: NEUTRAL, detail: "momentum unknown" };
        let v = band(m.momentum, -1, 0.1, 3, 12); // vertical candles get penalised
        if (m.momentumAcceleration !== null && m.momentumAcceleration > 0) {
          v = Math.min(1, v + 0.15);
        }
        return { value: v, detail: `momentum ${m.momentum.toFixed(2)}%/min` };
      })(),
    },
    {
      metric: "stability",
      weight: w.stability,
      s: (() => {
        const parts: number[] = [];
        const details: string[] = [];
        if (m.liquidityChangePct !== null) {
          parts.push(band(m.liquidityChangePct, -30, -5, 40, 200));
          details.push(`liq ${m.liquidityChangePct >= 0 ? "+" : ""}${m.liquidityChangePct.toFixed(0)}%`);
        }
        if (m.volatility5m !== null) {
          parts.push(1 - ramp(m.volatility5m, 4, 20));
          details.push(`volatility ${m.volatility5m.toFixed(1)}%`);
        }
        if (m.estSlippagePctFor1Sol !== null) {
          parts.push(1 - ramp(m.estSlippagePctFor1Sol, 1, 8));
          details.push(`~${m.estSlippagePctFor1Sol.toFixed(1)}% slippage/1 SOL`);
        }
        if (parts.length === 0) return { value: NEUTRAL, detail: "stability unknown" };
        return {
          value: parts.reduce((a, b) => a + b, 0) / parts.length,
          detail: details.join(", "),
        };
      })(),
    },
    {
      metric: "safety",
      weight: w.safety,
      s: (() => {
        const parts: number[] = [];
        const details: string[] = [];
        if (m.mintAuthorityRevoked !== null) {
          parts.push(m.mintAuthorityRevoked ? 1 : 0);
          details.push(m.mintAuthorityRevoked ? "mint revoked" : "MINT ACTIVE");
        }
        if (m.freezeAuthorityRevoked !== null) {
          parts.push(m.freezeAuthorityRevoked ? 1 : 0);
          details.push(m.freezeAuthorityRevoked ? "freeze revoked" : "FREEZE ACTIVE");
        }
        if (m.lpBurnedOrLockedPct !== null) {
          parts.push(ramp(m.lpBurnedOrLockedPct, 50, 95));
          details.push(`LP ${m.lpBurnedOrLockedPct.toFixed(0)}% burned/locked`);
        }
        if (m.devSoldPct !== null) {
          parts.push(1 - ramp(m.devSoldPct, 20, 80));
          details.push(`dev sold ${m.devSoldPct.toFixed(0)}%`);
        }
        if (m.devReputationScore !== null) {
          parts.push(m.devReputationScore);
          details.push(`dev rep ${(m.devReputationScore * 100).toFixed(0)}/100`);
        }
        if (parts.length === 0) return { value: NEUTRAL, detail: "safety checks unavailable" };
        return {
          value: parts.reduce((a, b) => a + b, 0) / parts.length,
          detail: details.join(", "),
        };
      })(),
    },
    {
      metric: "activity",
      weight: w.activity,
      s: scoreOrNeutral(m.txPerMinute, (v) => ({
        value: band(v, 2, 10, 120, 400),
        detail: `${v.toFixed(0)} tx/min`,
      }), "tx velocity unknown"),
    },
  ];

  return entries.map(({ metric, weight, s }) => ({
    metric,
    weight,
    value: s.value,
    detail: s.detail,
    contribution: s.value * weight,
  }));
}

// ── flags ───────────────────────────────────────────────────────────────────

function buildGreenFlags(m: TokenMetrics): FlagResult[] {
  const flags: FlagResult[] = [];
  const add = (id: string, label: string, detail: string) => flags.push({ id, label, detail });

  if (m.liquiditySol !== null && m.liquiditySol >= 100)
    add("strong_liquidity", "Strong liquidity", `${m.liquiditySol.toFixed(0)} SOL pooled`);
  if (m.holderGrowth5m !== null && m.holderGrowth5m >= 25)
    add("holder_growth", "Healthy holder growth", `+${m.holderGrowth5m} holders in 5m`);
  if (m.buySellRatio !== null && m.buySellRatio >= 1.5 && m.buySellRatio <= 5)
    add("buy_pressure", "Strong buy pressure", `buy/sell ${m.buySellRatio.toFixed(2)}`);
  if (m.volumeGrowthPct !== null && m.volumeGrowthPct >= 30)
    add("volume_up", "Increasing volume", `+${m.volumeGrowthPct.toFixed(0)}% vs previous window`);
  if (m.top10HolderPct !== null && m.top10HolderPct <= 20)
    add("healthy_distribution", "Healthy wallet distribution", `top10 hold ${m.top10HolderPct.toFixed(1)}%`);
  if (m.topHolderPct !== null && m.topHolderPct <= 4)
    add("no_whale", "No whale dominance", `largest holder ${m.topHolderPct.toFixed(1)}%`);
  if (m.devWalletPct !== null && m.devWalletPct <= 2)
    add("clean_dev", "No suspicious developer allocation", `dev holds ${m.devWalletPct.toFixed(1)}%`);
  if (m.momentum !== null && m.momentum > 0.2 && m.momentum < 8)
    add("positive_momentum", "Positive momentum", `${m.momentum.toFixed(2)}%/min`);
  if (m.freshWalletPct !== null && m.freshWalletPct <= 20)
    add("organic_wallets", "Organic wallet creation", `only ${m.freshWalletPct.toFixed(0)}% fresh wallets`);
  if (m.liquidityChangePct !== null && Math.abs(m.liquidityChangePct) <= 10)
    add("stable_liquidity", "Stable liquidity", `${m.liquidityChangePct.toFixed(1)}% drift since detection`);
  if (m.txPerMinute !== null && m.txPerMinute >= 15 && m.txPerMinute <= 200)
    add("good_velocity", "Good transaction velocity", `${m.txPerMinute.toFixed(0)} tx/min`);
  if (m.mintAuthorityRevoked === true && m.freezeAuthorityRevoked === true)
    add("authorities_revoked", "Mint & freeze authority revoked", "contract cannot mint or freeze");
  if (m.lpBurnedOrLockedPct !== null && m.lpBurnedOrLockedPct >= 95)
    add("lp_secured", "LP burned/locked", `${m.lpBurnedOrLockedPct.toFixed(0)}% of LP secured`);
  return flags;
}

interface RedFlag extends FlagResult {
  critical: boolean;
  penalty: number; // points subtracted from the total
}

function buildRedFlags(m: TokenMetrics): RedFlag[] {
  const flags: RedFlag[] = [];
  const add = (id: string, label: string, detail: string, penalty: number, critical = false) =>
    flags.push({ id, label, detail, penalty, critical });

  // Critical — these block buying no matter what the score says.
  if (m.isHoneypotSuspected === true)
    add("honeypot", "Possible honeypot", "sell transactions failing", 100, true);
  if (m.freezeAuthorityRevoked === false)
    add("freeze_active", "Freeze authority active", "trading can be frozen at any time", 60, true);
  if (m.mintAuthorityRevoked === false)
    add("mint_active", "Mint authority active", "supply can be inflated at any time", 60, true);
  if (m.liquidityChangePct !== null && m.liquidityChangePct <= -30)
    add("liquidity_removal", "Liquidity being removed", `${m.liquidityChangePct.toFixed(0)}% since detection`, 100, true);
  if (m.devSoldPct !== null && m.devSoldPct >= 60)
    add("dev_dumping", "Developer dumping", `dev sold ${m.devSoldPct.toFixed(0)}% of allocation`, 80, true);

  // Non-critical — subtract points proportionally.
  if (m.devWalletPct !== null && m.devWalletPct > 10)
    add("insider_allocation", "Large insider allocation", `dev holds ${m.devWalletPct.toFixed(1)}%`, 20);
  if (m.topHolderPct !== null && m.topHolderPct > 15)
    add("whale_concentration", "Wallet concentration", `one wallet holds ${m.topHolderPct.toFixed(1)}%`, 18);
  if (m.top10HolderPct !== null && m.top10HolderPct > 50)
    add("top10_concentration", "Top-10 concentration", `top10 hold ${m.top10HolderPct.toFixed(1)}%`, 15);
  if (m.artificialVolumeSuspected === true)
    add("artificial_volume", "Artificial volume", "volume far exceeds unique wallets", 25);
  if (m.washTradingSuspected === true)
    add("wash_trading", "Wash trading suspected", "circular flows between related wallets", 25);
  if (m.sniperWalletCount !== null && m.sniperWalletCount > 15)
    add("sniper_swarm", "Massive sniper activity", `${m.sniperWalletCount} sniper wallets`, 15);
  if (m.bundledWalletCount !== null && m.bundledWalletCount > 8)
    add("bundled_wallets", "Bundled wallets", `${m.bundledWalletCount} wallets funded from one source`, 18);
  if (m.volatility5m !== null && m.volatility5m > 25)
    add("excess_volatility", "Excessive volatility", `${m.volatility5m.toFixed(1)}% 1m stdev`, 10);
  if (m.liquiditySol !== null && m.liquiditySol < 20)
    add("poor_liquidity", "Poor liquidity", `only ${m.liquiditySol.toFixed(1)} SOL pooled`, 20);
  if (m.lpBurnedOrLockedPct !== null && m.lpBurnedOrLockedPct < 50)
    add("lp_at_risk", "Liquidity removal risk", `only ${m.lpBurnedOrLockedPct.toFixed(0)}% of LP secured`, 20);
  if (m.freshWalletPct !== null && m.freshWalletPct > 60)
    add("fresh_wallet_swarm", "Spam / fresh-wallet swarm", `${m.freshWalletPct.toFixed(0)}% of buyers are fresh wallets`, 15);
  if (m.devReputationScore !== null && m.devReputationScore < 0.25)
    add("bad_dev_history", "Poor developer history", "prior launches rugged or abandoned", 20);

  return flags;
}

// ── main entry ──────────────────────────────────────────────────────────────

export function scoreToken(
  metrics: TokenMetrics,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ScoreResult {
  const metricScores = buildMetricScores(metrics, weights);
  const totalWeight = metricScores.reduce((a, s) => a + s.weight, 0);
  const weightedBase =
    (metricScores.reduce((a, s) => a + s.contribution, 0) / totalWeight) * 100;

  const greenFlags = buildGreenFlags(metrics);
  const redFlags = buildRedFlags(metrics);

  // Green flags nudge the score up (capped), red flags subtract their penalty.
  const greenBonus = Math.min(10, greenFlags.length * 1.5);
  const redPenalty = redFlags.reduce((a, f) => a + f.penalty, 0);

  const total = Math.round(Math.max(0, Math.min(100, weightedBase + greenBonus - redPenalty)));
  const criticalFlags = redFlags.filter((f) => f.critical);

  const explanation =
    `Base ${weightedBase.toFixed(1)} from ${metricScores.length} weighted metrics, ` +
    `+${greenBonus.toFixed(1)} from ${greenFlags.length} green flag(s), ` +
    `-${redPenalty} from ${redFlags.length} red flag(s)` +
    (criticalFlags.length
      ? `. CRITICAL: ${criticalFlags.map((f) => f.label).join(", ")} — buying blocked.`
      : ".") +
    (metrics.missingSources.length
      ? ` Missing data: ${metrics.missingSources.join(", ")} (scored neutral).`
      : "");

  return {
    total,
    metrics: metricScores,
    greenFlags,
    redFlags: redFlags.map(({ id, label, detail }) => ({ id, label, detail })),
    criticalFlags: criticalFlags.map(({ id, label, detail }) => ({ id, label, detail })),
    missingSources: metrics.missingSources,
    explanation,
  };
}
