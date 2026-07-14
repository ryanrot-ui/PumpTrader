import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";
import { loadClosedTrades } from "@/engine/learning/loadTrades";
import { computeTradeStats } from "@/engine/learning/tradeStats";

const DAY_MS = 86_400_000;

/**
 * Analytics for the dashboard. `?mode=paper|live|all` (default all) filters
 * every position-derived metric, so paper and live performance share one
 * analytics system while staying clearly separable. Closed-trade numbers are
 * computed by the shared learning/tradeStats module (the same definitions
 * the strategy reports and optimizer use); scanner counters come from
 * DailyStats. Full bucket analyses live in /api/analytics.
 */
async function handleGet(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const mode = (searchParams.get("mode") ?? "all") as "paper" | "live" | "all";
  const paperFilter = mode === "paper" ? true : mode === "live" ? false : undefined;

  const [closed, open, daily, totalTrades] = await Promise.all([
    loadClosedTrades({ mode }),
    prisma.position.findMany({
      where: { ...(paperFilter === undefined ? {} : { paper: paperFilter }), status: "OPEN" },
    }),
    prisma.dailyStats.findMany({ orderBy: { date: "asc" }, take: 90 }),
    prisma.trade.count({ where: paperFilter === undefined ? {} : { paper: paperFilter } }),
  ]);

  const s = computeTradeStats(closed);
  const invested = closed.reduce((a, p) => a + p.entrySol, 0);

  // Rolling profit windows
  const now = Date.now();
  const profitSince = (ms: number) =>
    closed.filter((p) => now - p.closedAt.getTime() <= ms).reduce((a, p) => a + p.pnlSol, 0);

  // Equity curve: cumulative realized PnL per UTC day
  const byDay = new Map<string, number>();
  for (const p of [...closed].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime())) {
    const day = p.closedAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + p.pnlSol);
  }
  let cumulative = 0;
  const equityCurve = [...byDay.entries()].map(([date, sol]) => {
    cumulative += sol;
    return { date, realizedSol: sol, cumulativeSol: cumulative };
  });

  const today = daily.find(
    (d) => d.date.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)
  );

  return NextResponse.json({
    mode,
    // Totals
    totalTrades,
    closedPositions: s.trades,
    openPositions: open.length,
    exposureSol: open.reduce((a, p) => a + p.entrySol, 0),
    winningTrades: s.wins,
    losingTrades: s.losses,
    winRate: s.winRate,
    successRate: s.trades ? ((s.trades - s.losses) / s.trades) * 100 : null,
    // Profit
    realizedSol: s.totalPnlSol,
    roiPct: invested > 0 ? (s.totalPnlSol / invested) * 100 : null,
    avgRoiPct: s.expectancyPct,
    avgPnlSol: s.trades ? s.totalPnlSol / s.trades : null,
    largestWinSol: closed.length ? Math.max(...closed.map((p) => p.pnlSol), 0) : null,
    largestLossSol: closed.length ? Math.min(...closed.map((p) => p.pnlSol), 0) : null,
    dailyRealizedSol: profitSince(DAY_MS),
    weeklyRealizedSol: profitSince(7 * DAY_MS),
    monthlyRealizedSol: profitSince(30 * DAY_MS),
    avgHoldMinutes: s.avgHoldMinutes,
    // Professional metrics (definitions in engine/learning/tradeStats.ts)
    profitFactor: s.profitFactor,
    expectancySol: s.expectancySol,
    expectancyPct: s.expectancyPct,
    avgWinnerSol: s.avgWinnerSol,
    avgLoserSol: s.avgLoserSol,
    avgWinnerPct: s.avgWinnerPct,
    avgLoserPct: s.avgLoserPct,
    avgRiskReward: s.avgRiskReward,
    sharpe: s.sharpe,
    maxDrawdownSol: s.maxDrawdownSol,
    maxDrawdownPct: s.maxDrawdownPct,
    avgHoldMinutesWinners: s.avgHoldMinutesWinners,
    avgHoldMinutesLosers: s.avgHoldMinutesLosers,
    avgEntryDelayMs: s.avgEntryDelayMs,
    avgGivebackPct: s.avgGivebackPct,
    roundTrips: s.roundTrips,
    maxConsecutiveWins: s.maxConsecutiveWins,
    maxConsecutiveLosses: s.maxConsecutiveLosses,
    currentStreak: s.currentStreak,
    // Light bucket views for the dashboard (full set in /api/analytics)
    byScore: s.byScore,
    byExitKind: s.byExitKind,
    byHourUtc: s.byHourUtc,
    // Series
    equityCurve,
    // Scanner activity (engine-wide, not mode-specific)
    today: today ?? null,
  });
}

export const GET = dbGuard(handleGet);
