import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publish, CHANNELS } from "@/lib/redis";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";
import { loadClosedTrades } from "@/engine/learning/loadTrades";
import { computeTradeStats } from "@/engine/learning/tradeStats";
import { optimizeWeights, MIN_TRADES_FOR_OPTIMIZATION } from "@/engine/learning/optimizer";
import { deriveAdjustments, generateStrategyReport } from "@/engine/learning/reporter";
import { computeFilterEffectiveness } from "@/engine/learning/missed";

/**
 * Learning analytics.
 *
 * GET  ?mode=paper|live|all — full trade statistics (win rate, profit factor,
 *      expectancy, drawdown, every bucket analysis), the current weight
 *      recommendation with per-metric evidence, plain-language strategy
 *      adjustments, and the most recent stored strategy reports.
 * POST {action:"generate"}     — generate + persist a strategy report now.
 * POST {action:"applyWeights"} — apply the optimizer's current recommended
 *      scoring weights to settings (the engine hot-reloads them).
 */

async function handleGet(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const mode = (searchParams.get("mode") ?? "all") as "paper" | "live" | "all";

  const trades = await loadClosedTrades({ mode });
  const stats = computeTradeStats(trades);
  const recommendation = optimizeWeights(trades);
  const adjustments = deriveAdjustments(stats);
  const [reports, missedDone, missedActive] = await Promise.all([
    prisma.strategyReport.findMany({
      orderBy: { at: "desc" },
      take: 5,
      select: { id: true, at: true, mode: true, tradesAnalyzed: true, trigger: true, weightsApplied: true },
    }),
    prisma.missedOpportunity.findMany({
      where: { doneAt: { not: null } },
      select: { mint: true, symbol: true, rejectedAt: true, score: true, rejectionReasons: true, hardFailRules: true, maxGainPct: true, maxLossPct: true, rugged: true },
      orderBy: { rejectedAt: "desc" },
      take: 2000,
    }),
    prisma.missedOpportunity.count({ where: { doneAt: null } }),
  ]);

  // Phase 2: grade every filter on rugs avoided vs winners missed
  const filterEffectiveness = computeFilterEffectiveness(missedDone);
  const topMissed = [...missedDone]
    .filter((m) => (m.maxGainPct ?? 0) >= 50 && m.rugged !== true)
    .sort((a, b) => (b.maxGainPct ?? 0) - (a.maxGainPct ?? 0))
    .slice(0, 10);

  return NextResponse.json({
    mode,
    stats,
    adjustments,
    recommendation,
    minTradesForOptimization: MIN_TRADES_FOR_OPTIMIZATION,
    reports,
    missed: {
      tracked: missedDone.length,
      active: missedActive,
      ruggedPct: missedDone.length
        ? (missedDone.filter((m) => m.rugged === true).length / missedDone.length) * 100
        : null,
      filterEffectiveness,
      topMissed,
    },
  });
}

async function handlePost(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as { action?: string; mode?: string };
  const mode = (body.mode ?? "all") as "paper" | "live" | "all";

  if (body.action === "generate") {
    const settings = await prisma.settings.findFirst({ orderBy: { updatedAt: "desc" } });
    const report = await generateStrategyReport({
      mode,
      trigger: "manual",
      autoApplyWeights: settings?.autoRebalanceWeights ?? false,
    });
    return NextResponse.json({ ok: true, report });
  }

  if (body.action === "applyWeights") {
    const trades = await loadClosedTrades({ mode });
    const recommendation = optimizeWeights(trades);
    if (!recommendation) {
      return NextResponse.json(
        { error: `Need at least ${MIN_TRADES_FOR_OPTIMIZATION} closed trades with entry snapshots to optimize weights.` },
        { status: 400 }
      );
    }
    await prisma.settings.updateMany({
      data: { scoringWeights: recommendation.recommended as unknown as Prisma.InputJsonValue },
    });
    publish(CHANNELS.settingsUpdated, "updated");
    await prisma.logEntry
      .create({
        data: {
          level: "info",
          source: "api",
          message: `scoring weights rebalanced from ${recommendation.tradesAnalyzed} trades by ${user.email}`,
          meta: JSON.parse(JSON.stringify(recommendation.recommended)),
        },
      })
      .catch(() => {});
    return NextResponse.json({ ok: true, applied: recommendation.recommended, evidence: recommendation.evidence });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export const GET = dbGuard(handleGet);
export const POST = dbGuard(handlePost);
