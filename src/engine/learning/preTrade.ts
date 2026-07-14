import type { ClosedTrade } from "./tradeStats";
import { deriveTags, type ReviewInput } from "./review";

/**
 * Pre-trade learning review: before EVERY buy, the current setup is checked
 * against everything already learned — the lessons database (win rate per
 * condition tag) and a nearest-neighbour similarity search over historical
 * trades. The result is a BOUNDED score adjustment plus a size multiplier,
 * with the full reasoning recorded on the trade.
 *
 * Anti-overfitting rules, enforced in the math:
 *  - a lesson only counts with ≥ MIN_TAG_TRADES trades behind it
 *  - per-lesson deltas are bounded; the combined adjustment is bounded
 *    asymmetrically (penalties may reach -25, bonuses only +10 — history
 *    can veto a trade, it must not talk the bot into one)
 *  - similarity verdicts need ≥ MIN_SIMILAR sufficiently-close neighbours;
 *    anything else is "unknown" and unknown setups trade SMALLER, never
 *    bigger ("no data" is not "good")
 */

export const MIN_TAG_TRADES = 20;
export const MIN_SIMILAR = 8;
const K_NEIGHBOURS = 15;
const MAX_NEIGHBOUR_DISTANCE = 0.9; // mean |z| difference across shared dims
const MIN_SHARED_DIMS = 5;
export const MAX_PENALTY = -25;
export const MAX_BONUS = 10;
const UNKNOWN_SIZE_MULT = 0.5;

export interface SetupFeatures {
  scannerScore: number;
  narrativeScore: number | null;
  liquiditySol: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  buySellRatio: number | null;
  momentum: number | null;
  momentumAcceleration: number | null;
  volatility5m: number | null;
  estSlippagePctFor1Sol: number | null;
  holderCount: number | null;
  tokenAgeMin: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  regime: string | null;
}

export interface LessonStat {
  tag: string;
  trades: number;
  winRate: number; // %
}

export interface LessonApplied {
  tag: string;
  trades: number;
  winRate: number;
  delta: number;
}

export interface SimilaritySummary {
  neighbours: number;
  winRate: number | null;
  avgPnlPct: number | null;
  verdict: "resembles_winners" | "resembles_losers" | "mixed" | "unknown";
}

export interface PreTradeReview {
  scoreDelta: number; // bounded combined adjustment
  sizeMultiplier: number; // 1 normally; 0.5 for unknown setups
  lessonsApplied: LessonApplied[];
  similarity: SimilaritySummary;
  summary: string; // one-line self-explanation for logs/trace
}

/** Condition tags for a live setup (same tagger the reviews use). */
export function tagsForSetup(f: SetupFeatures): string[] {
  const synthetic: ReviewInput = {
    positionId: "",
    mint: "",
    symbol: null,
    paper: true,
    pnlSol: 0,
    pnlPct: null,
    holdMinutes: null,
    exitReason: "",
    exitKind: "",
    maxUnrealizedPnlPct: null,
    maxDrawdownPct: null,
    takeProfitPct: 12,
    stopLossPct: 6,
    entrySignals: {
      scannerScore: f.scannerScore,
      narrativeScore: f.narrativeScore ?? undefined,
      context: {
        liquiditySol: f.liquiditySol,
        buySellRatio: f.buySellRatio,
        momentumAcceleration: f.momentumAcceleration,
        priceChange5mPct: f.priceChange5mPct,
        volatility5m: f.volatility5m,
        estSlippagePctFor1Sol: f.estSlippagePctFor1Sol,
        holderCount: f.holderCount,
        tokenAgeMin: f.tokenAgeMin,
        detectionToBuyMs: null,
        regime: f.regime,
      },
    },
  };
  return deriveTags(synthetic);
}

/** Bounded per-lesson delta from its measured win rate vs the 50% baseline. */
export function lessonDelta(winRate: number): number {
  const dev = winRate - 50;
  if (dev < 0) return Math.max(-15, Math.round(dev * 0.45)); // 22% WR → -12.6 → -13
  return Math.min(8, Math.round(dev * 0.35)); // 68% WR → +6
}

// ── similarity (k-nearest neighbours on z-scored features) ──────────────────

type Extractor = (t: ClosedTrade) => number | null;
const DIMS: Array<{ name: keyof SetupFeatures; log?: boolean; from: Extractor }> = [
  { name: "liquiditySol", log: true, from: (t) => t.entryLiquiditySol },
  { name: "marketCapUsd", log: true, from: (t) => t.entryMarketCapUsd },
  { name: "volume5mUsd", log: true, from: (t) => t.entryContext?.volume5mUsd ?? null },
  { name: "buySellRatio", from: (t) => t.entryContext?.buySellRatio ?? null },
  { name: "momentum", from: (t) => t.entryContext?.momentum ?? null },
  { name: "momentumAcceleration", from: (t) => t.entryContext?.momentumAcceleration ?? null },
  { name: "volatility5m", from: (t) => t.entryContext?.volatility5m ?? null },
  { name: "estSlippagePctFor1Sol", from: (t) => t.entryContext?.estSlippagePctFor1Sol ?? null },
  { name: "holderCount", log: true, from: (t) => t.entryContext?.holderCount ?? null },
  { name: "tokenAgeMin", from: (t) => t.tokenAgeMinAtEntry },
  { name: "scannerScore", from: (t) => t.score },
];

const tf = (v: number | null, log?: boolean) =>
  v == null || !Number.isFinite(v) ? null : log ? Math.log10(Math.max(v, 0.001)) : v;

export function analyzeSimilarity(setup: SetupFeatures, history: ClosedTrade[]): SimilaritySummary {
  if (history.length < MIN_SIMILAR) {
    return { neighbours: 0, winRate: null, avgPnlPct: null, verdict: "unknown" };
  }

  // z-normalization stats per dimension over the history
  const stats = DIMS.map((d) => {
    const vals = history.map((t) => tf(d.from(t), d.log)).filter((v): v is number => v != null);
    if (vals.length < MIN_SIMILAR) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 1;
    return { mean, sd };
  });

  const setupVec = DIMS.map((d, i) =>
    stats[i] ? tf(setup[d.name] as number | null, d.log) : null
  );

  const scored: Array<{ t: ClosedTrade; dist: number }> = [];
  for (const t of history) {
    let sum = 0;
    let dims = 0;
    for (let i = 0; i < DIMS.length; i++) {
      const s = stats[i];
      const sv = setupVec[i];
      if (!s || sv == null) continue;
      const hv = tf(DIMS[i].from(t), DIMS[i].log);
      if (hv == null) continue;
      sum += Math.abs((sv - s.mean) / s.sd - (hv - s.mean) / s.sd);
      dims++;
    }
    if (dims >= MIN_SHARED_DIMS) scored.push({ t, dist: sum / dims });
  }

  const neighbours = scored
    .sort((a, b) => a.dist - b.dist)
    .slice(0, K_NEIGHBOURS)
    .filter((s) => s.dist <= MAX_NEIGHBOUR_DISTANCE);

  if (neighbours.length < MIN_SIMILAR) {
    return { neighbours: neighbours.length, winRate: null, avgPnlPct: null, verdict: "unknown" };
  }

  const wins = neighbours.filter((n) => n.t.pnlSol > 0).length;
  const winRate = (wins / neighbours.length) * 100;
  const pnls = neighbours.map((n) => n.t.pnlPct).filter((v): v is number => v != null);
  const avgPnlPct = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
  const verdict =
    winRate >= 60 ? "resembles_winners" : winRate <= 40 ? "resembles_losers" : "mixed";
  return { neighbours: neighbours.length, winRate, avgPnlPct, verdict };
}

// ── the review ───────────────────────────────────────────────────────────────

export function preTradeReview(
  setup: SetupFeatures,
  history: ClosedTrade[],
  lessons: LessonStat[]
): PreTradeReview {
  // 1. Lessons: measured win rate of every condition this setup trades under
  const tags = tagsForSetup(setup);
  const byTag = new Map(lessons.map((l) => [l.tag, l]));
  const lessonsApplied: LessonApplied[] = [];
  for (const tag of tags) {
    const l = byTag.get(tag);
    if (!l || l.trades < MIN_TAG_TRADES) continue;
    const delta = lessonDelta(l.winRate);
    if (delta !== 0) lessonsApplied.push({ tag, trades: l.trades, winRate: l.winRate, delta });
  }

  // 2. Similarity: does this setup resemble past winners or losers?
  const similarity = analyzeSimilarity(setup, history);
  let similarityDelta = 0;
  if (similarity.verdict === "resembles_losers") {
    similarityDelta = Math.max(-12, Math.round(((similarity.winRate ?? 40) - 50) * 0.4));
  } else if (similarity.verdict === "resembles_winners") {
    similarityDelta = Math.min(6, Math.round(((similarity.winRate ?? 60) - 50) * 0.25));
  }

  // 3. Combine, bounded asymmetrically
  const raw = lessonsApplied.reduce((a, l) => a + l.delta, 0) + similarityDelta;
  const scoreDelta = Math.max(MAX_PENALTY, Math.min(MAX_BONUS, raw));

  // 4. Unknown setups trade smaller — no data is not good news
  const sizeMultiplier = similarity.verdict === "unknown" && history.length >= MIN_SIMILAR ? UNKNOWN_SIZE_MULT : 1;

  const parts: string[] = [];
  parts.push(
    similarity.verdict === "unknown"
      ? `no sufficiently similar history (${similarity.neighbours} close neighbours) — unknown pattern, half size`
      : `${similarity.verdict.replace(/_/g, " ")}: ${similarity.neighbours} similar trades won ${similarity.winRate?.toFixed(0)}% (avg ${similarity.avgPnlPct != null ? `${similarity.avgPnlPct >= 0 ? "+" : ""}${similarity.avgPnlPct.toFixed(1)}%` : "–"})`
  );
  for (const l of lessonsApplied.slice(0, 4)) {
    parts.push(`${l.tag.replace(/_/g, " ")}: ${l.winRate.toFixed(0)}% WR over ${l.trades} → ${l.delta >= 0 ? "+" : ""}${l.delta}`);
  }
  const summary = `learning review ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}: ${parts.join(" · ")}`;

  return { scoreDelta, sizeMultiplier, lessonsApplied, similarity, summary };
}
