import { prisma } from "@/lib/prisma";
import { classifyExitKind, type ClosedTrade } from "./tradeStats";

/**
 * Loads closed positions and adapts them into ClosedTrade for the analytics
 * and the optimizer.
 *
 * New positions carry everything in entrySignals (metric breakdown, entry
 * context, timing) — one query. Historical positions fall back to joins:
 * DetectedToken (by mint) for token age / detection delay, and the last
 * ScoreRecord before entry for the per-metric breakdown. Both joins are
 * batched (one query each), never per-row, to stay cheap on Neon Free.
 */

interface EntrySignals {
  scannerScore?: number;
  metrics?: Record<string, number>;
  context?: {
    marketCapUsd?: number | null;
    liquiditySol?: number | null;
    tokenAgeMin?: number | null;
    detectionToBuyMs?: number | null;
  };
}

export async function loadClosedTrades(opts: {
  mode?: "paper" | "live" | "all";
  limit?: number;
}): Promise<ClosedTrade[]> {
  const { mode = "all", limit = 2000 } = opts;
  const where = {
    status: "CLOSED",
    ...(mode === "all" ? {} : { paper: mode === "paper" }),
  };
  const positions = await prisma.position.findMany({
    where,
    orderBy: { closedAt: "desc" },
    take: limit,
  });

  // Batched fallback joins for positions predating the entrySignals context.
  const needToken = positions.filter((p) => {
    const sig = (p.entrySignals ?? {}) as EntrySignals;
    return sig.context?.tokenAgeMin == null;
  });
  const tokens = needToken.length
    ? await prisma.detectedToken.findMany({
        where: { mint: { in: [...new Set(needToken.map((p) => p.mint))] } },
        select: { id: true, mint: true, migratedAt: true, detectedAt: true },
      })
    : [];
  const tokenByMint = new Map(tokens.map((t) => [t.mint, t]));

  const needMetrics = positions.filter((p) => {
    const sig = (p.entrySignals ?? {}) as EntrySignals;
    return !sig.metrics && tokenByMint.has(p.mint);
  });
  const scoreRows = needMetrics.length
    ? await prisma.scoreRecord.findMany({
        where: {
          tokenId: { in: [...new Set(needMetrics.map((p) => tokenByMint.get(p.mint)!.id))] },
        },
        orderBy: { at: "desc" },
        select: { tokenId: true, at: true, breakdown: true },
        take: 5000,
      })
    : [];
  // latest breakdown per token at or before each position's entry
  const scoresByToken = new Map<string, Array<{ at: Date; breakdown: unknown }>>();
  for (const r of scoreRows) {
    const arr = scoresByToken.get(r.tokenId) ?? [];
    arr.push({ at: r.at, breakdown: r.breakdown });
    scoresByToken.set(r.tokenId, arr);
  }

  return positions
    .filter((p) => p.closedAt != null)
    .map((p) => {
      const sig = (p.entrySignals ?? {}) as EntrySignals;
      const token = tokenByMint.get(p.mint);

      let entryMetrics: Record<string, number> | null = sig.metrics ?? null;
      if (!entryMetrics && token) {
        const candidates = (scoresByToken.get(token.id) ?? []).filter(
          (s) => s.at.getTime() <= p.openedAt.getTime() + 60_000
        );
        const latest = candidates[0]; // rows are ordered desc
        if (latest && Array.isArray(latest.breakdown)) {
          entryMetrics = {};
          for (const m of latest.breakdown as Array<{ metric?: string; value?: number }>) {
            if (m.metric && typeof m.value === "number") entryMetrics[m.metric] = m.value;
          }
        }
      }

      const tokenAgeMinAtEntry =
        sig.context?.tokenAgeMin ??
        (token ? (p.openedAt.getTime() - token.migratedAt.getTime()) / 60_000 : null);
      const detectionToBuyMs =
        sig.context?.detectionToBuyMs ??
        (token ? p.openedAt.getTime() - token.detectedAt.getTime() : null);

      return {
        pnlSol: p.pnlSol ?? 0,
        pnlPct: p.pnlPct,
        entrySol: p.entrySol,
        openedAt: p.openedAt,
        closedAt: p.closedAt!,
        exitReason: p.exitReason,
        exitKind: classifyExitKind(p.exitReason),
        entryReason: p.entryReason,
        score: p.scannerScore,
        entryMarketCapUsd: sig.context?.marketCapUsd ?? null,
        entryLiquiditySol: sig.context?.liquiditySol ?? null,
        tokenAgeMinAtEntry,
        detectionToBuyMs,
        maxUnrealizedPnlPct: p.maxUnrealizedPnlPct,
        maxDrawdownPct: p.maxDrawdownPct,
        entryMetrics,
        paper: p.paper,
      } satisfies ClosedTrade;
    });
}
