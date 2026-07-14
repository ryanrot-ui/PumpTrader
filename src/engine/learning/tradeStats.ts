/**
 * Trade analytics: every professional statistic the strategy is judged by,
 * computed from closed positions (the financial record). Pure functions —
 * the data loader (loadTrades.ts) adapts Prisma rows into ClosedTrade.
 *
 * These numbers drive the strategy reports and the weight optimizer, so the
 * definitions are deliberately standard:
 *   profit factor = gross wins / gross losses
 *   expectancy    = (winRate × avgWin) − (lossRate × avgLoss)
 *   Sharpe        = mean(trade ROI) / stdev(trade ROI)  (per-trade, not annualized)
 *   max drawdown  = deepest peak-to-trough fall of the cumulative PnL curve
 */

export interface ClosedTrade {
  pnlSol: number;
  pnlPct: number | null;
  entrySol: number;
  openedAt: Date;
  closedAt: Date;
  exitReason: string | null; // raw reason text from the position
  exitKind: string; // classified: take_profit | stop_loss | trailing_stop | ...
  entryReason: string | null;
  score: number | null; // scanner score at entry
  entryMarketCapUsd: number | null;
  entryLiquiditySol: number | null;
  tokenAgeMinAtEntry: number | null; // minutes between migration and entry
  detectionToBuyMs: number | null; // detection → buy confirmation
  maxUnrealizedPnlPct: number | null; // best gain seen while open
  maxDrawdownPct: number | null; // worst excursion seen while open
  /** per-metric 0..1 quality values at entry (scoring breakdown), if recorded */
  entryMetrics: Record<string, number> | null;
  paper: boolean;
}

export interface BucketStat {
  label: string;
  trades: number;
  wins: number;
  winRate: number | null; // %
  pnlSol: number;
  avgPnlPct: number | null;
}

export interface ReasonStat {
  reason: string;
  count: number;
  pnlSol: number;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null; // %
  totalPnlSol: number;
  avgWinnerSol: number | null;
  avgLoserSol: number | null; // positive magnitude
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  profitFactor: number | null; // null when no losses yet (undefined ratio)
  expectancySol: number | null; // expected PnL per trade
  expectancyPct: number | null; // expected ROI per trade, %
  avgRiskReward: number | null; // avgWinner / avgLoser
  sharpe: number | null; // per-trade, from % returns
  maxDrawdownSol: number | null; // deepest equity-curve fall
  maxDrawdownPct: number | null; // vs the equity peak at the time
  avgHoldMinutes: number | null;
  avgHoldMinutesWinners: number | null;
  avgHoldMinutesLosers: number | null;
  avgEntryDelayMs: number | null; // detection → buy
  /** exit lateness: how much unrealized profit winners gave back before the
   *  exit fired, and how many trades peaked above +5% but closed at a loss */
  avgGivebackPct: number | null;
  roundTrips: number; // peaked ≥ +5% unrealized, closed ≤ 0
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  currentStreak: number; // positive = wins, negative = losses
  byScore: BucketStat[];
  byMarketCap: BucketStat[];
  byLiquidity: BucketStat[];
  byTokenAge: BucketStat[];
  byHoldTime: BucketStat[];
  byExitKind: BucketStat[];
  byHourUtc: BucketStat[];
  topWinReasons: ReasonStat[];
  topLossReasons: ReasonStat[];
}

const holdMinutes = (t: ClosedTrade) =>
  (t.closedAt.getTime() - t.openedAt.getTime()) / 60_000;

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Classify a free-text exit reason into a stable kind for bucketing. */
export function classifyExitKind(reason: string | null): string {
  if (!reason) return "unknown";
  const r = reason.toLowerCase();
  if (r.includes("take profit")) return "take_profit";
  if (r.includes("stop loss")) return "stop_loss";
  if (r.includes("trailing")) return "trailing_stop";
  if (r.includes("weak position") || r.includes("weak_exit")) return "weak_exit";
  if (r.includes("buy pressure") || r.includes("volume faded") || r.includes("momentum"))
    return "momentum_exit";
  if (r.includes("liquidity") || r.includes("sells failing") || r.includes("emergency"))
    return "rug_exit";
  if (r.includes("time exit") || r.includes("held")) return "time_exit";
  if (r.includes("narrative")) return "narrative_exit";
  if (r.includes("reconciled")) return "reconciled";
  return "other";
}

function bucketize(
  trades: ClosedTrade[],
  labelOf: (t: ClosedTrade) => string | null,
  order?: string[]
): BucketStat[] {
  const map = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const label = labelOf(t);
    if (label === null) continue;
    const arr = map.get(label) ?? [];
    arr.push(t);
    map.set(label, arr);
  }
  const stats = [...map.entries()].map(([label, ts]) => {
    const wins = ts.filter((t) => t.pnlSol > 0).length;
    const pcts = ts.map((t) => t.pnlPct).filter((v): v is number => v != null);
    return {
      label,
      trades: ts.length,
      wins,
      winRate: ts.length ? (wins / ts.length) * 100 : null,
      pnlSol: ts.reduce((a, t) => a + t.pnlSol, 0),
      avgPnlPct: mean(pcts),
    };
  });
  if (order) {
    stats.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  } else {
    stats.sort((a, b) => b.pnlSol - a.pnlSol);
  }
  return stats;
}

function rangeBucket(v: number | null, edges: number[], labels: string[]): string | null {
  if (v === null) return null;
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

const SCORE_LABELS = ["<50", "50-59", "60-69", "70-79", "80-89", "90-100"];
const SCORE_EDGES = [50, 60, 70, 80, 90];
const MCAP_LABELS = ["<$50k", "$50-100k", "$100-250k", "$250k-1M", ">$1M"];
const MCAP_EDGES = [50_000, 100_000, 250_000, 1_000_000];
const LIQ_LABELS = ["<25 SOL", "25-50", "50-100", "100-300", ">300 SOL"];
const LIQ_EDGES = [25, 50, 100, 300];
const AGE_LABELS = ["<3 min", "3-6", "6-12", "12-25", ">25 min"];
const AGE_EDGES = [3, 6, 12, 25];
const HOLD_LABELS = ["<2 min", "2-5", "5-10", "10-30", ">30 min"];
const HOLD_EDGES = [2, 5, 10, 30];

/** Top-N most frequent reason fragments among a set of trades. */
function topReasons(trades: ClosedTrade[], n = 10): ReasonStat[] {
  const map = new Map<string, { count: number; pnlSol: number }>();
  for (const t of trades) {
    const fragments = new Set<string>();
    // Exit kind always counts as a reason; entry reasons are ';'-separated.
    fragments.add(`exit: ${t.exitKind.replace(/_/g, " ")}`);
    for (const frag of (t.entryReason ?? "").split(";")) {
      const clean = frag
        .trim()
        .replace(/^score \d+:?\s*/i, "")
        // strip trade-specific numbers so reasons aggregate
        .replace(/\d+(\.\d+)?/g, "N")
        .toLowerCase();
      if (clean.length >= 4) fragments.add(`entry: ${clean}`);
    }
    for (const f of fragments) {
      const cur = map.get(f) ?? { count: 0, pnlSol: 0 };
      cur.count++;
      cur.pnlSol += t.pnlSol;
      map.set(f, cur);
    }
  }
  return [...map.entries()]
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

export function computeTradeStats(input: ClosedTrade[]): TradeStats {
  const trades = [...input].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  const winners = trades.filter((t) => t.pnlSol > 0);
  const losers = trades.filter((t) => t.pnlSol <= 0);

  const grossWin = winners.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(losers.reduce((a, t) => a + t.pnlSol, 0));

  const avgWinnerSol = mean(winners.map((t) => t.pnlSol));
  const avgLoserSol = losers.length ? grossLoss / losers.length : null;
  const winRate = trades.length ? (winners.length / trades.length) * 100 : null;

  const expectancySol =
    winRate !== null && trades.length
      ? (winRate / 100) * (avgWinnerSol ?? 0) - (1 - winRate / 100) * (avgLoserSol ?? 0)
      : null;

  const pcts = trades.map((t) => t.pnlPct).filter((v): v is number => v != null);
  const winnerPcts = winners.map((t) => t.pnlPct).filter((v): v is number => v != null);
  const loserPcts = losers.map((t) => t.pnlPct).filter((v): v is number => v != null);
  const meanPct = mean(pcts);
  let sharpe: number | null = null;
  if (pcts.length >= 3 && meanPct !== null) {
    const variance = pcts.reduce((a, r) => a + (r - meanPct) ** 2, 0) / (pcts.length - 1);
    const stdev = Math.sqrt(variance);
    sharpe = stdev > 0 ? meanPct / stdev : null;
  }

  // Equity-curve max drawdown, in SOL and as % of the peak at the time.
  let equity = 0;
  let peak = 0;
  let maxDrawdownSol = 0;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    equity += t.pnlSol;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownSol) {
      maxDrawdownSol = dd;
      maxDrawdownPct = peak > 0 ? (dd / peak) * 100 : 100;
    }
  }

  // Streaks
  let maxWins = 0;
  let maxLosses = 0;
  let run = 0;
  for (const t of trades) {
    const win = t.pnlSol > 0;
    run = win ? Math.max(run, 0) + 1 : Math.min(run, 0) - 1;
    if (run > maxWins) maxWins = run;
    if (-run > maxLosses) maxLosses = -run;
  }

  // Exit lateness: profit given back between the in-trade peak and the exit.
  const givebacks = winners
    .filter((t) => t.maxUnrealizedPnlPct != null && t.pnlPct != null)
    .map((t) => Math.max(0, t.maxUnrealizedPnlPct! - t.pnlPct!));
  const roundTrips = trades.filter(
    (t) => (t.maxUnrealizedPnlPct ?? 0) >= 5 && t.pnlSol <= 0
  ).length;

  const entryDelays = trades
    .map((t) => t.detectionToBuyMs)
    .filter((v): v is number => v != null && v >= 0);

  return {
    trades: trades.length,
    wins: winners.length,
    losses: losers.length,
    winRate,
    totalPnlSol: trades.reduce((a, t) => a + t.pnlSol, 0),
    avgWinnerSol,
    avgLoserSol,
    avgWinnerPct: mean(winnerPcts),
    avgLoserPct: loserPcts.length ? Math.abs(mean(loserPcts)!) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancySol,
    expectancyPct: meanPct,
    avgRiskReward:
      avgWinnerSol !== null && avgLoserSol !== null && avgLoserSol > 0
        ? avgWinnerSol / avgLoserSol
        : null,
    sharpe,
    maxDrawdownSol: trades.length ? maxDrawdownSol : null,
    maxDrawdownPct: trades.length ? maxDrawdownPct : null,
    avgHoldMinutes: mean(trades.map(holdMinutes)),
    avgHoldMinutesWinners: mean(winners.map(holdMinutes)),
    avgHoldMinutesLosers: mean(losers.map(holdMinutes)),
    avgEntryDelayMs: mean(entryDelays),
    avgGivebackPct: mean(givebacks),
    roundTrips,
    maxConsecutiveWins: maxWins,
    maxConsecutiveLosses: maxLosses,
    currentStreak: run,
    byScore: bucketize(trades, (t) => rangeBucket(t.score, SCORE_EDGES, SCORE_LABELS), SCORE_LABELS),
    byMarketCap: bucketize(trades, (t) => rangeBucket(t.entryMarketCapUsd, MCAP_EDGES, MCAP_LABELS), MCAP_LABELS),
    byLiquidity: bucketize(trades, (t) => rangeBucket(t.entryLiquiditySol, LIQ_EDGES, LIQ_LABELS), LIQ_LABELS),
    byTokenAge: bucketize(trades, (t) => rangeBucket(t.tokenAgeMinAtEntry, AGE_EDGES, AGE_LABELS), AGE_LABELS),
    byHoldTime: bucketize(trades, (t) => rangeBucket(holdMinutes(t), HOLD_EDGES, HOLD_LABELS), HOLD_LABELS),
    byExitKind: bucketize(trades, (t) => t.exitKind),
    byHourUtc: bucketize(trades, (t) => `${String(t.openedAt.getUTCHours()).padStart(2, "0")}:00`),
    topWinReasons: topReasons(winners),
    topLossReasons: topReasons(losers),
  };
}
