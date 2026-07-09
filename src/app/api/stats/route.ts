import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";

const DAY_MS = 86_400_000;

/**
 * Analytics for the dashboard. `?mode=paper|live|all` (default all) filters
 * every position-derived metric, so paper and live performance share one
 * analytics system while staying clearly separable. Profit series and
 * aggregates are computed from closed positions (the financial record);
 * scanner counters (scanned/bought/rejected) come from DailyStats.
 */
export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "all"; // paper | live | all
  const paperFilter = mode === "paper" ? true : mode === "live" ? false : undefined;
  const where = paperFilter === undefined ? {} : { paper: paperFilter };

  const [closed, open, daily, totalTrades] = await Promise.all([
    prisma.position.findMany({
      where: { ...where, status: "CLOSED" },
      orderBy: { closedAt: "asc" },
    }),
    prisma.position.findMany({ where: { ...where, status: "OPEN" } }),
    prisma.dailyStats.findMany({ orderBy: { date: "asc" }, take: 90 }),
    prisma.trade.count({ where: paperFilter === undefined ? {} : { paper: paperFilter } }),
  ]);

  const realizedSol = closed.reduce((a, p) => a + (p.pnlSol ?? 0), 0);
  const wins = closed.filter((p) => (p.pnlSol ?? 0) > 0).length;
  const losses = closed.length - wins;
  const invested = closed.reduce((a, p) => a + p.entrySol, 0);

  const holdsMin = closed
    .filter((p) => p.closedAt)
    .map((p) => (p.closedAt!.getTime() - p.openedAt.getTime()) / 60_000);
  const pnls = closed.map((p) => p.pnlSol ?? 0);
  const rois = closed.map((p) => p.pnlPct).filter((v): v is number => v != null);

  // Rolling profit windows (from closed positions, so they respect the mode filter)
  const now = Date.now();
  const profitSince = (ms: number) =>
    closed
      .filter((p) => p.closedAt && now - p.closedAt.getTime() <= ms)
      .reduce((a, p) => a + (p.pnlSol ?? 0), 0);

  // Equity curve: cumulative realized PnL per UTC day
  const byDay = new Map<string, number>();
  for (const p of closed) {
    if (!p.closedAt) continue;
    const day = p.closedAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (p.pnlSol ?? 0));
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
    closedPositions: closed.length,
    openPositions: open.length,
    exposureSol: open.reduce((a, p) => a + p.entrySol, 0),
    winningTrades: wins,
    losingTrades: losses,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    // Success = closed without losing money (breakeven counts as success)
    successRate: closed.length
      ? (closed.filter((p) => (p.pnlSol ?? 0) >= 0).length / closed.length) * 100
      : null,
    // Profit
    realizedSol,
    roiPct: invested > 0 ? (realizedSol / invested) * 100 : null,
    avgRoiPct: rois.length ? rois.reduce((a, b) => a + b, 0) / rois.length : null,
    avgPnlSol: pnls.length ? realizedSol / pnls.length : null,
    largestWinSol: pnls.length ? Math.max(...pnls, 0) : null,
    largestLossSol: pnls.length ? Math.min(...pnls, 0) : null,
    dailyRealizedSol: profitSince(DAY_MS),
    weeklyRealizedSol: profitSince(7 * DAY_MS),
    monthlyRealizedSol: profitSince(30 * DAY_MS),
    avgHoldMinutes: holdsMin.length ? holdsMin.reduce((a, b) => a + b, 0) / holdsMin.length : null,
    // Series
    equityCurve,
    // Scanner activity (engine-wide, not mode-specific)
    today: today ?? null,
  });
}
