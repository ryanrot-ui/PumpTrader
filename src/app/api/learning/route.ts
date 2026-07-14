import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publish, CHANNELS } from "@/lib/redis";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";
import { loadClosedTrades } from "@/engine/learning/loadTrades";
import { detectPatterns, MIN_RELEVANT_TRADES } from "@/engine/learning/patterns";
import { compareSettings, loadTokenSeries } from "@/engine/backtest/replay";
import { settingsSchema, settingsUpdateSchema } from "@/lib/validation";
import { DEFAULT_SETTINGS } from "@/engine/config";
import type { BotSettings } from "@/lib/validation";

/**
 * The learning loop's API.
 *
 * GET: everything the Learning page shows — lessons (win rate per condition
 * tag), top win/loss causes, recent trade reviews, current
 * significance-gated recommendations, parameter-change history, win rate
 * over time, and the composite strategy confidence.
 *
 * POST:
 *  {action:"apply", changes:{key:value,...}, note?} — backtests the change
 *    against the current strategy FIRST; applies only if the replay improves
 *    (or force:true), records a revertible ParameterChange.
 *  {action:"revert", changeId} — restores the `before` values of a change.
 */

interface CauseRow {
  cause: string;
  confidencePct: number;
}

/** Json columns need the sentinel to store SQL NULL (clears the override). */
function withJsonNulls(data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data };
  for (const k of ["scoringWeights", "narrativeWeights"]) {
    if (k in d && d[k] === null) d[k] = Prisma.DbNull;
  }
  return d;
}

async function handleGet(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const mode = (searchParams.get("mode") ?? "all") as "paper" | "live" | "all";

  const [reviews, trades, changes, settingsRow] = await Promise.all([
    prisma.tradeReview.findMany({
      where: mode === "all" ? {} : { paper: mode === "paper" },
      orderBy: { at: "desc" },
      take: 2000,
    }),
    loadClosedTrades({ mode }),
    prisma.parameterChange.findMany({ orderBy: { at: "desc" }, take: 25 }),
    prisma.settings.findFirst({ orderBy: { updatedAt: "desc" } }),
  ]);

  // ── Lessons: win rate per objective condition tag ─────────────────────────
  const lessonMap = new Map<string, { trades: number; wins: number; pnlSol: number }>();
  for (const r of reviews) {
    for (const tag of r.tags) {
      const cur = lessonMap.get(tag) ?? { trades: 0, wins: 0, pnlSol: 0 };
      cur.trades++;
      if (r.win) cur.wins++;
      cur.pnlSol += r.pnlSol;
      lessonMap.set(tag, cur);
    }
  }
  const lessons = [...lessonMap.entries()]
    .map(([tag, v]) => ({
      tag,
      trades: v.trades,
      winRate: (v.wins / v.trades) * 100,
      pnlSol: v.pnlSol,
    }))
    .filter((l) => l.trades >= 5)
    .sort((a, b) => a.winRate - b.winRate);

  // ── Top causes, confidence-weighted ───────────────────────────────────────
  const causeTotals = (win: boolean) => {
    const map = new Map<string, { count: number; weight: number }>();
    for (const r of reviews.filter((x) => x.win === win)) {
      for (const c of (r.causes as unknown as CauseRow[]) ?? []) {
        const cur = map.get(c.cause) ?? { count: 0, weight: 0 };
        cur.count++;
        cur.weight += c.confidencePct / 100;
        map.set(c.cause, cur);
      }
    }
    return [...map.entries()]
      .map(([cause, v]) => ({ cause, count: v.count, weightedCount: Math.round(v.weight * 10) / 10 }))
      .sort((a, b) => b.weightedCount - a.weightedCount)
      .slice(0, 10);
  };

  // ── Patterns & recommendations (significance-gated) ──────────────────────
  const currentSettings: BotSettings = settingsRow
    ? (() => {
        const { id: _i, userId: _u, updatedAt: _t, ...vals } = settingsRow;
        const parsed = settingsSchema.safeParse(vals);
        return parsed.success ? parsed.data : DEFAULT_SETTINGS;
      })()
    : DEFAULT_SETTINGS;
  const patterns = detectPatterns(trades, currentSettings);

  // ── Win rate over time (rolling 20-trade window) ──────────────────────────
  const chron = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  const winRateSeries: Array<{ trade: number; winRate: number; at: string }> = [];
  const WINDOW = 20;
  for (let i = WINDOW; i <= chron.length; i += Math.max(1, Math.floor(WINDOW / 4))) {
    const slice = chron.slice(i - WINDOW, i);
    winRateSeries.push({
      trade: i,
      winRate: (slice.filter((t) => t.pnlSol > 0).length / slice.length) * 100,
      at: slice[slice.length - 1].closedAt.toISOString(),
    });
  }

  return NextResponse.json({
    mode,
    reviewsStored: reviews.length,
    minRelevantTrades: MIN_RELEVANT_TRADES,
    lessons,
    topLossCauses: causeTotals(false),
    topWinCauses: causeTotals(true),
    recentReviews: reviews.slice(0, 12).map((r) => ({
      id: r.id,
      at: r.at,
      mint: r.mint,
      symbol: r.symbol,
      win: r.win,
      pnlPct: r.pnlPct,
      exitKind: r.exitKind,
      causes: (r.causes as unknown as CauseRow[])?.slice(0, 3) ?? [],
      tags: r.tags,
    })),
    patterns,
    parameterChanges: changes,
    winRateSeries,
  });
}

async function handlePost(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    changes?: Record<string, unknown>;
    note?: string;
    force?: boolean;
    changeId?: string;
  };

  const settingsRow = await prisma.settings.findFirst({ orderBy: { updatedAt: "desc" } });
  if (!settingsRow) return NextResponse.json({ error: "no settings row yet" }, { status: 400 });
  const { id: rowId, userId: _u, updatedAt: _t, ...currentValues } = settingsRow;
  const current = settingsSchema.safeParse(currentValues);
  if (!current.success) return NextResponse.json({ error: "stored settings invalid" }, { status: 500 });

  if (body.action === "apply") {
    // Validate the proposed keys against the settings schema (partial).
    const partial = settingsUpdateSchema.partial().safeParse(body.changes ?? {});
    if (!partial.success || Object.keys(partial.data).length === 0) {
      return NextResponse.json({ error: "invalid or empty changes" }, { status: 400 });
    }
    const proposed: BotSettings = { ...current.data, ...partial.data };

    // BACKTEST FIRST: replay recorded history under both parameter sets.
    const series = await loadTokenSeries({ maxTokens: 400 });
    const comparison = series.length >= 20 ? compareSettings(series, current.data, proposed) : null;
    if (comparison && !comparison.improves && !body.force) {
      return NextResponse.json(
        { applied: false, comparison, error: comparison.verdict },
        { status: 409 }
      );
    }

    const changedKeys = Object.keys(partial.data);
    const before = Object.fromEntries(changedKeys.map((k) => [k, (current.data as Record<string, unknown>)[k] ?? null]));
    await prisma.$transaction([
      prisma.settings.update({
        where: { id: rowId },
        data: withJsonNulls(partial.data) as Prisma.SettingsUpdateInput,
      }),
      prisma.parameterChange.create({
        data: {
          source: "recommendation",
          changedKeys,
          before: JSON.parse(JSON.stringify(before)),
          after: JSON.parse(JSON.stringify(partial.data)),
          note:
            body.note ??
            (comparison ? comparison.verdict : "applied without replay comparison (insufficient recorded history)"),
        },
      }),
    ]);
    publish(CHANNELS.settingsUpdated, "updated");
    return NextResponse.json({ applied: true, comparison });
  }

  if (body.action === "revert") {
    if (!body.changeId) return NextResponse.json({ error: "changeId required" }, { status: 400 });
    const change = await prisma.parameterChange.findUnique({ where: { id: body.changeId } });
    if (!change) return NextResponse.json({ error: "change not found" }, { status: 404 });
    const beforeVals = settingsUpdateSchema.partial().safeParse(change.before);
    if (!beforeVals.success || Object.keys(beforeVals.data).length === 0) {
      return NextResponse.json({ error: "stored change is not revertible" }, { status: 400 });
    }
    await prisma.$transaction([
      prisma.settings.update({
        where: { id: rowId },
        data: withJsonNulls(beforeVals.data) as Prisma.SettingsUpdateInput,
      }),
      prisma.parameterChange.create({
        data: {
          source: "revert",
          changedKeys: change.changedKeys,
          // these are always the JSON objects we wrote in the apply path
          before: change.after as Prisma.InputJsonValue,
          after: change.before as Prisma.InputJsonValue,
          note: `revert of change ${change.id}`,
        },
      }),
    ]);
    publish(CHANNELS.settingsUpdated, "updated");
    return NextResponse.json({ reverted: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export const GET = dbGuard(handleGet);
export const POST = dbGuard(handlePost);
