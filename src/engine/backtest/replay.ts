import { prisma } from "@/lib/prisma";
import { DEFAULT_SETTINGS } from "../config";
import { evaluateExit } from "../trading/exitRules";
import { classifyExitKind, computeTradeStats, type ClosedTrade, type TradeStats } from "../learning/tradeStats";
import { PRESETS, type StrategyPreset } from "@/lib/presets";
import type { BotSettings } from "@/lib/validation";

/**
 * Backtesting by replay: every detected token's stored evaluation history
 * (ScoreRecord + TokenSnapshot, written every scanner cycle while the token
 * was watched) is replayed against each strategy preset. Entries fire where
 * the recorded score crossed the preset's threshold; exits are simulated by
 * the REAL exit engine (evaluateExit) walking the recorded price/liquidity/
 * flow series — so a preset comparison exercises the exact production logic.
 *
 * Honest limitations, stated in the API response:
 *  - fills are assumed at the recorded snapshot price (no slippage model)
 *  - the safety gates that need live RPC data (authorities, honeypot) are
 *    not re-evaluated; the score threshold is the comparable dimension
 *  - resolution is the scanner interval (~15s), so intrabar spikes between
 *    snapshots are invisible to both entries and exits
 */

const MIN_AGE_BEFORE_BUY_S = 90; // mirror the live engine's settle window
const NOTIONAL_SOL = 0.1; // per-trade size used for SOL-denominated stats

export interface BacktestResult {
  preset: string;
  label: string;
  tokensConsidered: number;
  trades: number;
  winRate: number | null;
  roiPct: number | null; // total PnL / total invested
  profitFactor: number | null;
  expectancyPct: number | null;
  maxDrawdownSol: number | null;
  avgHoldMinutes: number | null;
  totalPnlSol: number;
  stats: TradeStats;
}

interface TimelinePoint {
  at: Date;
  priceUsd: number | null;
  liquiditySol: number | null;
  volume5mUsd: number | null;
  buySellRatio: number | null;
  marketCapUsd: number | null;
  score: number | null;
}

export interface TokenSeries {
  mint: string;
  migratedAt: Date;
  detectedAt: Date;
  points: TimelinePoint[];
}

/** Load replayable token series (snapshots merged with scores by timestamp). */
export async function loadTokenSeries(opts: { maxTokens?: number } = {}): Promise<TokenSeries[]> {
  const { maxTokens = 400 } = opts;
  const tokens = await prisma.detectedToken.findMany({
    orderBy: { detectedAt: "desc" },
    take: maxTokens,
    select: { id: true, mint: true, migratedAt: true, detectedAt: true },
  });
  if (tokens.length === 0) return [];
  const ids = tokens.map((t) => t.id);
  const [snapshots, scores] = await Promise.all([
    prisma.tokenSnapshot.findMany({
      where: { tokenId: { in: ids } },
      orderBy: { at: "asc" },
      select: {
        tokenId: true,
        at: true,
        priceUsd: true,
        liquiditySol: true,
        volume5mUsd: true,
        buySellRatio: true,
        marketCapUsd: true,
      },
    }),
    prisma.scoreRecord.findMany({
      where: { tokenId: { in: ids } },
      orderBy: { at: "asc" },
      select: { tokenId: true, at: true, total: true, critical: true },
    }),
  ]);

  const snapsByToken = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    const arr = snapsByToken.get(s.tokenId) ?? [];
    arr.push(s);
    snapsByToken.set(s.tokenId, arr);
  }
  const scoresByToken = new Map<string, typeof scores>();
  for (const s of scores) {
    const arr = scoresByToken.get(s.tokenId) ?? [];
    arr.push(s);
    scoresByToken.set(s.tokenId, arr);
  }

  return tokens
    .map((t) => {
      const snaps = snapsByToken.get(t.id) ?? [];
      const scr = scoresByToken.get(t.id) ?? [];
      // score at each snapshot = the latest score at or before that moment;
      // critical-flagged evaluations are excluded as entries entirely.
      let si = 0;
      let current: { total: number; critical: boolean } | null = null;
      const points: TimelinePoint[] = snaps.map((s) => {
        while (si < scr.length && scr[si].at.getTime() <= s.at.getTime()) {
          current = scr[si];
          si++;
        }
        return {
          at: s.at,
          priceUsd: s.priceUsd,
          liquiditySol: s.liquiditySol,
          volume5mUsd: s.volume5mUsd,
          buySellRatio: s.buySellRatio,
          marketCapUsd: s.marketCapUsd,
          score: current && !current.critical ? current.total : null,
        };
      });
      return { mint: t.mint, migratedAt: t.migratedAt, detectedAt: t.detectedAt, points };
    })
    .filter((s) => s.points.filter((p) => p.priceUsd != null).length >= 4);
}

/** Replay one token against one settings profile. Returns a trade or null. */
export function simulateToken(series: TokenSeries, s: BotSettings): ClosedTrade | null {
  const pts = series.points;
  // Entry: first point after the settle window where the score clears the bar
  let entryIdx = -1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.priceUsd == null || p.score == null) continue;
    const ageS = (p.at.getTime() - series.migratedAt.getTime()) / 1000;
    if (ageS < MIN_AGE_BEFORE_BUY_S) continue;
    if (p.score >= s.confidenceThreshold) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0 || entryIdx === pts.length - 1) return null;

  const entry = pts[entryIdx];
  const entryPrice = entry.priceUsd!;
  let peak = entryPrice;
  let maxUnrealized = 0;
  let maxDrawdown = 0;
  let exitPrice: number | null = null;
  let exitAt: Date | null = null;
  let exitReason = "data end — series finished while position open";

  for (let i = entryIdx + 1; i < pts.length; i++) {
    const p = pts[i];
    if (p.priceUsd == null) continue;
    peak = Math.max(peak, p.priceUsd);
    const unrl = ((p.priceUsd - entryPrice) / entryPrice) * 100;
    maxUnrealized = Math.max(maxUnrealized, unrl);
    maxDrawdown = Math.min(maxDrawdown, ((p.priceUsd - peak) / peak) * 100);

    const liquidityDropPct =
      entry.liquiditySol && p.liquiditySol != null && entry.liquiditySol > 0
        ? ((p.liquiditySol - entry.liquiditySol) / entry.liquiditySol) * 100
        : null;

    const decision = evaluateExit(s, {
      entryPriceUsd: entryPrice,
      currentPriceUsd: p.priceUsd,
      peakPriceUsd: peak,
      openedAt: entry.at,
      now: p.at,
      liquidityDropPct,
      buySellRatio5m: p.buySellRatio,
      volume5mUsd: p.volume5mUsd,
      entryVolume5mUsd: entry.volume5mUsd,
    });
    if (decision.exit) {
      exitPrice = p.priceUsd;
      exitAt = p.at;
      exitReason = decision.reason;
      break;
    }
  }

  if (exitPrice == null || exitAt == null) {
    const last = [...pts].reverse().find((p) => p.priceUsd != null);
    if (!last) return null;
    exitPrice = last.priceUsd!;
    exitAt = last.at;
  }

  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  return {
    pnlSol: NOTIONAL_SOL * (pnlPct / 100),
    pnlPct,
    entrySol: NOTIONAL_SOL,
    openedAt: entry.at,
    closedAt: exitAt,
    exitReason,
    exitKind: exitReason.startsWith("data end") ? "data_end" : classifyExitKind(exitReason),
    entryReason: `score ${pts[entryIdx].score} ≥ ${s.confidenceThreshold}`,
    score: pts[entryIdx].score,
    entryMarketCapUsd: entry.marketCapUsd,
    entryLiquiditySol: entry.liquiditySol,
    tokenAgeMinAtEntry: (entry.at.getTime() - series.migratedAt.getTime()) / 60_000,
    detectionToBuyMs: entry.at.getTime() - series.detectedAt.getTime(),
    maxUnrealizedPnlPct: maxUnrealized,
    maxDrawdownPct: maxDrawdown,
    entryMetrics: null,
    paper: true,
  };
}

export function runBacktest(
  series: TokenSeries[],
  presets: StrategyPreset[] = PRESETS
): BacktestResult[] {
  return presets.map((preset) => {
    const settings = { ...DEFAULT_SETTINGS, ...preset.values } as BotSettings;
    const trades = series
      .map((t) => simulateToken(t, settings))
      .filter((t): t is ClosedTrade => t !== null);
    const stats = computeTradeStats(trades);
    const invested = trades.reduce((a, t) => a + t.entrySol, 0);
    return {
      preset: preset.name,
      label: preset.label,
      tokensConsidered: series.length,
      trades: stats.trades,
      winRate: stats.winRate,
      roiPct: invested > 0 ? (stats.totalPnlSol / invested) * 100 : null,
      profitFactor: stats.profitFactor,
      expectancyPct: stats.expectancyPct,
      maxDrawdownSol: stats.maxDrawdownSol,
      avgHoldMinutes: stats.avgHoldMinutes,
      totalPnlSol: stats.totalPnlSol,
      stats,
    };
  });
}
