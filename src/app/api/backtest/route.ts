import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";
import { loadTokenSeries, runBacktest } from "@/engine/backtest/replay";

/**
 * Strategy backtest: replays the stored evaluation history of recently
 * detected tokens (score + price/liquidity/flow snapshots recorded every
 * scanner cycle) against every strategy profile, using the production exit
 * engine. GET ?tokens=400 (max 800).
 *
 * Results are directionally honest but not exact: fills at snapshot prices,
 * no slippage model, ~15s resolution, RPC-only safety gates not re-checked.
 */
async function handleGet(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const maxTokens = Math.min(800, Math.max(20, parseInt(searchParams.get("tokens") ?? "400", 10) || 400));

  const series = await loadTokenSeries({ maxTokens });
  const results = runBacktest(series);

  return NextResponse.json({
    tokensReplayed: series.length,
    // sorted best-first by total PnL so the table reads as a leaderboard
    results: [...results].sort((a, b) => b.totalPnlSol - a.totalPnlSol),
    caveats: [
      "fills assumed at recorded snapshot prices (no slippage model)",
      "RPC-dependent safety gates (authorities, honeypot) not re-evaluated",
      "resolution = scanner interval (~15s); intrabar spikes invisible",
      "history window = snapshot retention (ARCHIVE_AFTER_DAYS, default 14d)",
    ],
  });
}

export const GET = dbGuard(handleGet);
