import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";
import { rateLimit } from "@/lib/rateLimit";

/**
 * Reset the dashboard statistics to zero: deletes PAPER trades, PAPER
 * positions, and the daily counters (scanned/bought/rejected/PnL windows).
 *
 * Deliberately untouched: LIVE trades and positions (they are financial
 * records of real transactions), detected tokens/scores (scanner history),
 * settings, wallets, and logs. Requires an explicit confirmation flag set
 * by the UI's confirm dialog.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (!(await rateLimit(`reset:${user.id}`, 3, 3600))) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const body = z
    .object({ confirm: z.literal(true) })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Confirmation required" }, { status: 400 });
  }

  const [trades, positions, days] = await prisma.$transaction([
    prisma.trade.deleteMany({ where: { paper: true } }),
    prisma.position.deleteMany({ where: { paper: true } }),
    prisma.dailyStats.deleteMany({}),
  ]);

  await prisma.logEntry
    .create({
      data: {
        level: "warn",
        source: "api",
        message: `statistics reset by ${user.email}: ${trades.count} paper trades, ${positions.count} paper positions, ${days.count} daily counters deleted (live records untouched)`,
      },
    })
    .catch(() => {});

  return NextResponse.json({
    ok: true,
    deleted: { paperTrades: trades.count, paperPositions: positions.count, dailyStats: days.count },
  });
}
