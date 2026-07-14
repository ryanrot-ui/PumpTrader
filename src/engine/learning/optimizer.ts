import { DEFAULT_WEIGHTS, type ScoringWeights } from "../analysis/scoring";
import type { ClosedTrade } from "./tradeStats";

/**
 * Data-driven scoring-weight rebalancing.
 *
 * For every scoring metric we compare its entry-time quality value (0..1,
 * recorded in the position's entry snapshot) between winning and losing
 * trades. A metric that is consistently higher on winners genuinely predicts
 * profitable trades and earns more weight; a metric that is the same (or
 * higher!) on losers is noise for this strategy and loses weight.
 *
 * Statistics, not vibes — but deliberately conservative:
 *  - point-biserial correlation between metric value and win/loss outcome
 *  - shrunk toward 0 for small samples (× n/(n+SHRINK)), so 30 trades move
 *    weights slightly and 500 trades move them meaningfully
 *  - each weight is bounded to [0.4×, 1.8×] of its default and the total is
 *    renormalized, so no single metric can take over the score and safety
 *    metrics can never be optimized to zero
 */

export interface MetricEvidence {
  metric: string;
  samples: number;
  winnerMean: number | null; // mean 0..1 value on winners
  loserMean: number | null;
  correlation: number | null; // shrunk point-biserial, -1..1
  currentWeight: number;
  recommendedWeight: number;
  direction: "increase" | "decrease" | "keep";
}

export interface WeightRecommendation {
  recommended: ScoringWeights;
  evidence: MetricEvidence[];
  tradesAnalyzed: number;
  summary: string;
}

export const MIN_TRADES_FOR_OPTIMIZATION = 30;
const SHRINK = 60; // sample-size shrinkage constant
const MAX_MULT = 1.8;
const MIN_MULT = 0.4;
/** How aggressively correlation moves weight: corr 0.3 → ±~0.45× before bounds. */
const GAIN = 1.5;

function pointBiserial(values: number[], wins: boolean[]): number | null {
  const n = values.length;
  if (n < 5) return null;
  const winVals = values.filter((_, i) => wins[i]);
  const loseVals = values.filter((_, i) => !wins[i]);
  if (winVals.length === 0 || loseVals.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  if (sd === 0) return 0;
  const mWin = winVals.reduce((a, b) => a + b, 0) / winVals.length;
  const mLose = loseVals.reduce((a, b) => a + b, 0) / loseVals.length;
  const p = winVals.length / n;
  return ((mWin - mLose) / sd) * Math.sqrt(p * (1 - p));
}

export function optimizeWeights(
  trades: ClosedTrade[],
  base: ScoringWeights = DEFAULT_WEIGHTS
): WeightRecommendation | null {
  const usable = trades.filter((t) => t.entryMetrics && Object.keys(t.entryMetrics).length > 0);
  if (usable.length < MIN_TRADES_FOR_OPTIMIZATION) return null;

  const metrics = Object.keys(base) as Array<keyof ScoringWeights>;
  const evidence: MetricEvidence[] = [];
  const raw: Record<string, number> = {};

  for (const metric of metrics) {
    const rows = usable
      .map((t) => ({ v: t.entryMetrics![metric], win: t.pnlSol > 0 }))
      .filter((r): r is { v: number; win: boolean } => typeof r.v === "number" && Number.isFinite(r.v));
    const values = rows.map((r) => r.v);
    const wins = rows.map((r) => r.win);
    const corr = pointBiserial(values, wins);
    const shrunk = corr === null ? 0 : corr * (rows.length / (rows.length + SHRINK));

    const mult = Math.max(MIN_MULT, Math.min(MAX_MULT, 1 + GAIN * shrunk));
    raw[metric] = base[metric] * mult;

    const winVals = rows.filter((r) => r.win).map((r) => r.v);
    const loseVals = rows.filter((r) => !r.win).map((r) => r.v);
    evidence.push({
      metric,
      samples: rows.length,
      winnerMean: winVals.length ? winVals.reduce((a, b) => a + b, 0) / winVals.length : null,
      loserMean: loseVals.length ? loseVals.reduce((a, b) => a + b, 0) / loseVals.length : null,
      correlation: corr === null ? null : shrunk,
      currentWeight: base[metric],
      recommendedWeight: 0, // filled after normalization
      direction: "keep",
    });
  }

  // Renormalize so the total weight budget is unchanged.
  const baseTotal = metrics.reduce((a, m) => a + base[m], 0);
  const rawTotal = metrics.reduce((a, m) => a + raw[m], 0);
  const recommended = {} as ScoringWeights;
  for (const m of metrics) {
    recommended[m] = Math.round((raw[m] / rawTotal) * baseTotal * 10) / 10;
  }
  for (const e of evidence) {
    e.recommendedWeight = recommended[e.metric as keyof ScoringWeights];
    const delta = e.recommendedWeight - e.currentWeight;
    e.direction = Math.abs(delta) < 0.5 ? "keep" : delta > 0 ? "increase" : "decrease";
  }

  const up = evidence
    .filter((e) => e.direction === "increase")
    .sort((a, b) => (b.correlation ?? 0) - (a.correlation ?? 0))
    .slice(0, 3)
    .map((e) => e.metric);
  const down = evidence
    .filter((e) => e.direction === "decrease")
    .sort((a, b) => (a.correlation ?? 0) - (b.correlation ?? 0))
    .slice(0, 3)
    .map((e) => e.metric);

  const summary =
    `Analyzed ${usable.length} closed trades with entry-signal snapshots. ` +
    (up.length ? `Predictive of wins (weight increased): ${up.join(", ")}. ` : "") +
    (down.length ? `Not predictive for this strategy (weight decreased): ${down.join(", ")}. ` : "") +
    `Weights are bounded to 0.4×–1.8× of defaults and renormalized to the same total, ` +
    `and correlations are shrunk toward zero for small samples.`;

  return { recommended, evidence, tradesAnalyzed: usable.length, summary };
}
