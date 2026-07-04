import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const [closed, open, daily] = await Promise.all([
    prisma.position.findMany({ where: { status: "CLOSED" } }),
    prisma.position.findMany({ where: { status: "OPEN" } }),
    prisma.dailyStats.findMany({ orderBy: { date: "asc" }, take: 90 }),
  ]);

  const realizedSol = closed.reduce((a, p) => a + (p.pnlSol ?? 0), 0);
  const wins = closed.filter((p) => (p.pnlSol ?? 0) > 0).length;
  const invested = closed.reduce((a, p) => a + p.entrySol, 0);

  // cumulative PnL series for the profit graph
  let cum = 0;
  const pnlSeries = daily.map((d) => {
    cum += d.realizedSol;
    return { date: d.date, realizedSol: d.realizedSol, cumulativeSol: cum };
  });

  return NextResponse.json({
    realizedSol,
    openPositions: open.length,
    exposureSol: open.reduce((a, p) => a + p.entrySol, 0),
    closedPositions: closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    roiPct: invested > 0 ? (realizedSol / invested) * 100 : null,
    pnlSeries,
    today: daily[daily.length - 1] ?? null,
  });
}
