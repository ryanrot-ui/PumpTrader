import type { BotSettings } from "@/lib/validation";
import type { ClosedTrade } from "./tradeStats";

/**
 * Pattern detection + parameter recommendations, with safe-learning rules
 * built into the math instead of left to discipline:
 *
 *  - MIN_RELEVANT_TRADES (50) trades carrying the tested signal, and at
 *    least MIN_SIDE (20) on each side of a candidate threshold — no
 *    conclusions from a handful of trades.
 *  - a two-proportion z-test between the win rates on either side of the
 *    threshold; only |z| ≥ 1.96 (~95%) is reported at all. Random noise
 *    does not clear that bar on these sample sizes.
 *  - recommendations state the measured evidence (win rate kept vs
 *    filtered, sample sizes, confidence) so every change is auditable, and
 *    the API backtests a proposal against the current strategy before it
 *    can be applied.
 */

export const MIN_RELEVANT_TRADES = 50;
const MIN_SIDE = 20;
const MIN_Z = 1.96;

export interface ParameterRecommendation {
  parameter: keyof BotSettings;
  label: string;
  current: number | boolean | null;
  proposed: number | boolean;
  direction: "raise" | "lower" | "enable";
  /** measured evidence behind the recommendation */
  evidence: {
    relevantTrades: number;
    keptTrades: number; // trades that would still be taken
    filteredTrades: number; // trades that would be rejected
    keptWinRate: number; // %
    filteredWinRate: number; // %
    overallWinRate: number; // %
    expectedWinRateDeltaPct: number; // kept − overall
    filteredPnlSol: number; // PnL of the trades that would be skipped
    zScore: number;
    confidencePct: number;
  };
  summary: string;
}

export interface PatternFinding {
  characteristic: string;
  group: "winners" | "losers";
  detail: string;
}

export interface PatternReport {
  tradesAnalyzed: number;
  findings: PatternFinding[];
  recommendations: ParameterRecommendation[];
  /** 0–100 composite confidence in the current strategy */
  strategyConfidence: number;
  strategyConfidenceDetail: string;
}

// ── Edge Score: one number for overall strategy quality ─────────────────────

export interface EdgeScore {
  score: number; // 0–100
  strengths: string[];
  weaknesses: string[];
  topImprovement: string;
}

/**
 * Composite strategy quality from MEASURED components: expectancy, profit
 * factor, exit efficiency (giveback), entry timing, filter accuracy, and
 * consistency. Each weakness names the evidence; the top improvement is the
 * weakest component — the highest-impact thing to fix next.
 */
export function computeEdgeScore(input: {
  stats: {
    trades: number;
    expectancySol: number | null;
    profitFactor: number | null;
    avgGivebackPct: number | null;
    roundTrips: number;
    avgEntryDelayMs: number | null;
    maxConsecutiveLosses: number;
    byScore: Array<{ label: string; trades: number; winRate: number | null; pnlSol: number }>;
  };
  avgFilterAccuracyPct: number | null; // from missed-opportunity grading
  frequencyStatus: string | null;
}): EdgeScore {
  const s = input.stats;
  const parts: Array<{ name: string; got: number; max: number; strong: string; weak: string }> = [];
  const add = (name: string, got: number, max: number, strong: string, weak: string) =>
    parts.push({ name, got: Math.max(0, Math.min(max, got)), max, strong, weak });

  add("expectancy", s.expectancySol != null && s.expectancySol > 0 ? 25 : s.expectancySol != null ? 25 + s.expectancySol * 500 : 10, 25,
    "positive expectancy per trade", `negative expectancy (${s.expectancySol?.toFixed(4) ?? "unrated"} SOL/trade)`);
  add("profit factor", s.profitFactor != null ? (s.profitFactor - 0.8) * 25 : 8, 20,
    `profit factor ${s.profitFactor?.toFixed(2)}`, `profit factor ${s.profitFactor?.toFixed(2) ?? "unrated"} — losses too large vs wins`);
  add("exits", s.avgGivebackPct != null ? 15 - s.avgGivebackPct : 8, 15,
    "exits keep most of the peak gain", `weak exits: winners give back ${s.avgGivebackPct?.toFixed(1)}% on average, ${s.roundTrips} round trips`);
  add("entry timing", s.avgEntryDelayMs != null ? 10 - (s.avgEntryDelayMs / 1000 - 20) / 10 : 5, 10,
    "fast detection→fill pipeline", `late entries: ${((s.avgEntryDelayMs ?? 0) / 1000).toFixed(0)}s average detection→fill`);
  add("filters", input.avgFilterAccuracyPct != null ? (input.avgFilterAccuracyPct - 40) / 4 : 7, 15,
    `filters ${input.avgFilterAccuracyPct?.toFixed(0)}% accurate (rugs avoided vs winners missed)`, `filters only ${input.avgFilterAccuracyPct?.toFixed(0)}% accurate — costing winners`);
  add("consistency", 15 - s.maxConsecutiveLosses, 15,
    "no destructive losing streaks", `losing streaks reach ${s.maxConsecutiveLosses} in a row`);

  const score = Math.round(parts.reduce((a, p) => a + p.got, 0));
  const strengths = parts.filter((p) => p.got >= p.max * 0.7).map((p) => p.strong);
  const weak = parts.filter((p) => p.got < p.max * 0.5).sort((a, b) => a.got / a.max - b.got / b.max);
  const weaknesses = weak.map((p) => p.weak);
  if (input.frequencyStatus === "over_selective") weaknesses.push("over-selective: frequency and daily profit both fell");
  return {
    score: Math.max(0, Math.min(100, score)),
    strengths: strengths.length ? strengths : ["none rated strong yet — needs more closed trades"],
    weaknesses: weaknesses.length ? weaknesses : ["no major weakness detected in this window"],
    topImprovement: weak[0]?.weak ?? "keep collecting data — no weak component stands out",
  };
}

/** Standard normal CDF (Abramowitz–Stegun approximation). */
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

function twoProportionZ(w1: number, n1: number, w2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 0;
  const p1 = w1 / n1;
  const p2 = w2 / n2;
  const p = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p1 - p2) / se;
}

interface Candidate {
  parameter: keyof BotSettings;
  label: string;
  /** value of the underlying signal for a trade (null = signal unrecorded) */
  value: (t: ClosedTrade) => number | null;
  /** thresholds to test */
  cutoffs: number[];
  /** "min": keep trades with value ≥ cutoff; "max": keep value ≤ cutoff */
  mode: "min" | "max";
}

const CANDIDATES: Candidate[] = [
  {
    parameter: "minLiquiditySol",
    label: "Minimum liquidity (SOL)",
    value: (t) => t.entryLiquiditySol,
    cutoffs: [20, 35, 50, 75, 100],
    mode: "min",
  },
  {
    parameter: "confidenceThreshold",
    label: "Confidence threshold (score)",
    value: (t) => t.score,
    cutoffs: [65, 70, 75, 80, 85, 90],
    mode: "min",
  },
  {
    parameter: "minBuyPressure",
    label: "Minimum buy pressure (buy/sell)",
    value: (t) => t.entryContext?.buySellRatio ?? null,
    cutoffs: [1.0, 1.2, 1.5, 2.0],
    mode: "min",
  },
  {
    parameter: "minVolume5mUsd",
    label: "Minimum 5m volume (USD)",
    value: (t) => t.entryContext?.volume5mUsd ?? null,
    cutoffs: [3_000, 5_000, 10_000, 20_000],
    mode: "min",
  },
  {
    parameter: "maxEntryPriceChange5mPct",
    label: "Max 5m price change at entry (%)",
    value: (t) => t.entryContext?.priceChange5mPct ?? null,
    cutoffs: [15, 20, 25, 35],
    mode: "max",
  },
  {
    parameter: "minHolders",
    label: "Minimum holders",
    value: (t) => t.entryContext?.holderCount ?? null,
    cutoffs: [50, 100, 200, 400],
    mode: "min",
  },
];

function winRate(ts: ClosedTrade[]): number {
  return ts.length ? (ts.filter((t) => t.pnlSol > 0).length / ts.length) * 100 : 0;
}

export function detectPatterns(trades: ClosedTrade[], settings?: Partial<BotSettings>): PatternReport {
  const findings: PatternFinding[] = [];
  const recommendations: ParameterRecommendation[] = [];
  const overallWr = winRate(trades);

  // ── Winner/loser shared characteristics (descriptive findings) ───────────
  const winners = trades.filter((t) => t.pnlSol > 0);
  const losers = trades.filter((t) => t.pnlSol <= 0);
  if (winners.length >= MIN_SIDE && losers.length >= MIN_SIDE) {
    const numeric: Array<{ name: string; value: (t: ClosedTrade) => number | null }> = [
      { name: "entry liquidity (SOL)", value: (t) => t.entryLiquiditySol },
      { name: "scanner score", value: (t) => t.score },
      { name: "buy/sell ratio at entry", value: (t) => t.entryContext?.buySellRatio ?? null },
      { name: "momentum acceleration at entry", value: (t) => t.entryContext?.momentumAcceleration ?? null },
      { name: "5m price change at entry (%)", value: (t) => t.entryContext?.priceChange5mPct ?? null },
      { name: "token age at entry (min)", value: (t) => t.tokenAgeMinAtEntry },
    ];
    for (const f of numeric) {
      const w = winners.map(f.value).filter((v): v is number => v != null);
      const l = losers.map(f.value).filter((v): v is number => v != null);
      if (w.length < MIN_SIDE || l.length < MIN_SIDE) continue;
      const mw = w.reduce((a, b) => a + b, 0) / w.length;
      const ml = l.reduce((a, b) => a + b, 0) / l.length;
      const all = [...w, ...l];
      const mean = all.reduce((a, b) => a + b, 0) / all.length;
      const sd = Math.sqrt(all.reduce((a, v) => a + (v - mean) ** 2, 0) / all.length) || 1;
      const effect = (mw - ml) / sd; // standardized difference
      if (Math.abs(effect) >= 0.3) {
        findings.push({
          characteristic: f.name,
          group: effect > 0 ? "winners" : "losers",
          detail: `${f.name}: winners avg ${mw.toFixed(2)}, losers avg ${ml.toFixed(2)} (effect ${effect.toFixed(2)}σ, n=${w.length}/${l.length})`,
        });
      }
    }
  }

  // ── Threshold recommendations (significance-gated) ───────────────────────
  for (const c of CANDIDATES) {
    const rows = trades
      .map((t) => ({ v: c.value(t), win: t.pnlSol > 0, pnlSol: t.pnlSol }))
      .filter((r): r is { v: number; win: boolean; pnlSol: number } => r.v != null && Number.isFinite(r.v));
    if (rows.length < MIN_RELEVANT_TRADES) continue;

    let best: ParameterRecommendation | null = null;
    for (const cutoff of c.cutoffs) {
      const kept = rows.filter((r) => (c.mode === "min" ? r.v >= cutoff : r.v <= cutoff));
      const filtered = rows.filter((r) => (c.mode === "min" ? r.v < cutoff : r.v > cutoff));
      if (kept.length < MIN_SIDE || filtered.length < MIN_SIDE) continue;

      const keptWins = kept.filter((r) => r.win).length;
      const filteredWins = filtered.filter((r) => r.win).length;
      const z = twoProportionZ(keptWins, kept.length, filteredWins, filtered.length);
      if (z < MIN_Z) continue; // kept side must be SIGNIFICANTLY better

      const keptWr = (keptWins / kept.length) * 100;
      const filteredWr = (filteredWins / filtered.length) * 100;
      const filteredPnl = filtered.reduce((a, r) => a + r.pnlSol, 0);
      if (filteredPnl > 0) continue; // never filter out trades that made money overall

      const current = (settings?.[c.parameter] ?? null) as number | null;
      // only recommend a tightening (raising a min / lowering a max)
      if (current != null) {
        if (c.mode === "min" && cutoff <= current) continue;
        if (c.mode === "max" && cutoff >= current) continue;
      }

      const rec: ParameterRecommendation = {
        parameter: c.parameter,
        label: c.label,
        current,
        proposed: cutoff,
        direction: c.mode === "min" ? "raise" : "lower",
        evidence: {
          relevantTrades: rows.length,
          keptTrades: kept.length,
          filteredTrades: filtered.length,
          keptWinRate: keptWr,
          filteredWinRate: filteredWr,
          overallWinRate: (rows.filter((r) => r.win).length / rows.length) * 100,
          expectedWinRateDeltaPct: keptWr - (rows.filter((r) => r.win).length / rows.length) * 100,
          filteredPnlSol: filteredPnl,
          zScore: z,
          confidencePct: Math.round(phi(z) * 100),
        },
        summary:
          `${c.label}: ${current ?? "—"} → ${cutoff}. Trades ${c.mode === "min" ? "≥" : "≤"} ${cutoff} won ` +
          `${keptWr.toFixed(0)}% (n=${kept.length}) vs ${filteredWr.toFixed(0)}% for the rest (n=${filtered.length}); ` +
          `skipping them would have avoided ${filteredPnl.toFixed(3)} SOL of PnL. ` +
          `Expected win-rate improvement ${(keptWr - (rows.filter((r) => r.win).length / rows.length) * 100).toFixed(1)}pp, confidence ${Math.round(phi(z) * 100)}%.`,
      };
      if (!best || rec.evidence.expectedWinRateDeltaPct > best.evidence.expectedWinRateDeltaPct) best = rec;
    }
    if (best) recommendations.push(best);
  }

  // Boolean candidate: require accelerating momentum
  const accelRows = trades
    .map((t) => ({ v: t.entryContext?.momentumAcceleration ?? null, win: t.pnlSol > 0, pnlSol: t.pnlSol }))
    .filter((r): r is { v: number; win: boolean; pnlSol: number } => r.v != null);
  if (accelRows.length >= MIN_RELEVANT_TRADES && settings?.requireRisingMomentum !== true) {
    const pos = accelRows.filter((r) => r.v > 0);
    const neg = accelRows.filter((r) => r.v <= 0);
    if (pos.length >= MIN_SIDE && neg.length >= MIN_SIDE) {
      const z = twoProportionZ(pos.filter((r) => r.win).length, pos.length, neg.filter((r) => r.win).length, neg.length);
      const negPnl = neg.reduce((a, r) => a + r.pnlSol, 0);
      if (z >= MIN_Z && negPnl <= 0) {
        const posWr = winRate(trades.filter((t) => (t.entryContext?.momentumAcceleration ?? -1) > 0));
        recommendations.push({
          parameter: "requireRisingMomentum",
          label: "Require accelerating momentum",
          current: false,
          proposed: true,
          direction: "enable",
          evidence: {
            relevantTrades: accelRows.length,
            keptTrades: pos.length,
            filteredTrades: neg.length,
            keptWinRate: (pos.filter((r) => r.win).length / pos.length) * 100,
            filteredWinRate: (neg.filter((r) => r.win).length / neg.length) * 100,
            overallWinRate: (accelRows.filter((r) => r.win).length / accelRows.length) * 100,
            expectedWinRateDeltaPct: posWr - (accelRows.filter((r) => r.win).length / accelRows.length) * 100,
            filteredPnlSol: negPnl,
            zScore: z,
            confidencePct: Math.round(phi(z) * 100),
          },
          summary: `Entries with building momentum won ${((pos.filter((r) => r.win).length / pos.length) * 100).toFixed(0)}% vs ${((neg.filter((r) => r.win).length / neg.length) * 100).toFixed(0)}% for fading ones (n=${pos.length}/${neg.length}, confidence ${Math.round(phi(z) * 100)}%). Enable requireRisingMomentum.`,
        });
      }
    }
  }

  // Rank by PROFIT impact (SOL the filtered trades lost), not win-rate
  // delta: the objective is maximum expectancy, not maximum win rate.
  recommendations.sort((a, b) => a.evidence.filteredPnlSol - b.evidence.filteredPnlSol);

  // ── Strategy confidence: sample size + edge + consistency ────────────────
  const n = trades.length;
  const samplePart = Math.min(40, (n / 200) * 40);
  const grossWin = winners.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(losers.reduce((a, t) => a + t.pnlSol, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 2 : 1;
  const pfPart = Math.min(30, Math.max(0, (pf - 0.8) * 25));
  // consistency: win rate of the two halves shouldn't diverge wildly
  let consistencyPart = 0;
  if (n >= 40) {
    const sorted = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
    const half = Math.floor(n / 2);
    const diff = Math.abs(winRate(sorted.slice(0, half)) - winRate(sorted.slice(half)));
    consistencyPart = Math.max(0, 30 - diff);
  }
  const strategyConfidence = Math.round(Math.min(100, samplePart + pfPart + consistencyPart));

  return {
    tradesAnalyzed: n,
    findings,
    recommendations: recommendations.slice(0, 5),
    strategyConfidence,
    strategyConfidenceDetail:
      `${n} trades (sample ${samplePart.toFixed(0)}/40) · profit factor ${pf.toFixed(2)} (edge ${pfPart.toFixed(0)}/30) · ` +
      (n >= 40 ? `first-half vs second-half win-rate consistency (${consistencyPart.toFixed(0)}/30)` : "consistency unrated below 40 trades (0/30)"),
  };
}
