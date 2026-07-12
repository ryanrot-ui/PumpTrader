import { NextResponse } from "next/server";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redis, redisEnabled } from "@/lib/redis";
import { engineAlive, getEngineState, type EngineHealth } from "@/lib/engineState";
import { detectPreset } from "@/lib/presets";
import { unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * One endpoint that answers "is every layer of this system actually
 * working?" — database, Redis, engine worker, settings pipeline, scoring
 * pipeline — with real measurements, not cached beliefs. JWT-only auth so it
 * keeps answering while the database is down.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as { id?: string } | undefined)?.id) return unauthorized();

  // ── Database ──────────────────────────────────────────────────────────────
  let db: { connected: boolean; latencyMs: number | null; schemaReady: boolean; error: string | null } = {
    connected: false,
    latencyMs: null,
    schemaReady: false,
    error: null,
  };
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public."User"') IS NOT NULL AS exists`;
    db = { connected: true, latencyMs: Date.now() - t0, schemaReady: rows[0]?.exists === true, error: null };
  } catch (e) {
    const err = e as Error;
    db.error = err.message.split("\n").map((s) => s.trim()).filter(Boolean).find((l) => !l.startsWith("Invalid ")) ?? err.message;
  }

  // ── Redis (optional accelerator) ──────────────────────────────────────────
  let redisStatus: { configured: boolean; connected: boolean | null } = {
    configured: redisEnabled,
    connected: null,
  };
  if (redisEnabled && redis) {
    redisStatus.connected = await Promise.race([
      redis.ping().then(() => true).catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
  }

  // Everything below needs the database.
  if (!db.connected) {
    return NextResponse.json({ db, redis: redisStatus, engine: null, settings: null, scoring: null, version: buildVersion() });
  }

  const [state, settingsRow, lastScore, lastScoringError, lastLogError] = await Promise.all([
    getEngineState().catch(() => null),
    prisma.settings.findFirst({ orderBy: { updatedAt: "desc" } }).catch(() => null),
    prisma.scoreRecord
      .findFirst({ orderBy: { at: "desc" }, include: { token: { select: { mint: true, symbol: true } } } })
      .catch(() => null),
    prisma.logEntry
      .findFirst({ where: { level: "error", source: "scoring" }, orderBy: { at: "desc" } })
      .catch(() => null),
    prisma.logEntry.findFirst({ where: { level: "error" }, orderBy: { at: "desc" } }).catch(() => null),
  ]);

  const health = (state?.health ?? {}) as EngineHealth;
  const heartbeatAgoMs = state?.heartbeatAt ? Date.now() - state.heartbeatAt.getTime() : null;

  return NextResponse.json({
    db,
    redis: redisStatus,
    engine: {
      alive: engineAlive(state?.heartbeatAt),
      status: state?.status ?? "unknown",
      heartbeatAgoMs,
      readOnly: state?.readOnly ?? false,
      rpcUrl: health.rpcUrl ?? null,
      rpcLatencyMs: health.rpcLatencyMs ?? null,
      scannerSubscribed: health.scannerSubscribed ?? null,
      lastScanAt: health.lastScanAt ?? null,
      tokensDetected: health.tokensDetected ?? null,
      settingsLoadedAt: health.settingsLoadedAt ?? null,
      // engine-side database circuit breaker (Neon resilience)
      dbCircuit: {
        status: health.dbStatus ?? null,
        consecutiveFailures: health.dbConsecutiveFailures ?? null,
        lastSuccessAt: health.dbLastSuccessAt ?? null,
        lastFailureAt: health.dbLastFailureAt ?? null,
        lastFailureReason: health.dbLastFailureReason ?? null,
        nextRetryInMs: health.dbNextRetryInMs ?? null,
        queuedWrites: health.dbQueuedWrites ?? null,
      },
    },
    settings: settingsRow
      ? {
          preset: detectPreset(settingsRow as unknown as Record<string, unknown>),
          updatedAt: settingsRow.updatedAt.getTime(),
          // Engine has reloaded iff the settings it runs on are the row's
          // current version.
          engineInSync:
            health.settingsLoadedAt != null &&
            health.settingsLoadedAt === settingsRow.updatedAt.getTime(),
          thresholds: {
            confidenceThreshold: settingsRow.confidenceThreshold,
            takeProfitPct: settingsRow.takeProfitPct,
            stopLossPct: settingsRow.stopLossPct,
            trailingStopPct: settingsRow.trailingStopPct,
            maxHoldMinutes: settingsRow.maxHoldMinutes,
            exitMinBuySellRatio: settingsRow.exitMinBuySellRatio,
            exitVolumeFadePct: settingsRow.exitVolumeFadePct,
            exitLiquidityDropPct: settingsRow.exitLiquidityDropPct,
            minLiquiditySol: settingsRow.minLiquiditySol,
            maxRugRiskScore: settingsRow.maxRugRiskScore,
            botEnabled: settingsRow.botEnabled,
            paperTrading: settingsRow.paperTrading,
          },
        }
      : null,
    scoring: {
      lastSuccess: lastScore
        ? { at: lastScore.at.getTime(), mint: lastScore.token?.mint ?? null, symbol: lastScore.token?.symbol ?? null, total: lastScore.total }
        : null,
      lastFailure: lastScoringError
        ? { at: lastScoringError.at.getTime(), message: lastScoringError.message, meta: lastScoringError.meta ?? null }
        : null,
    },
    lastError: lastLogError
      ? { at: lastLogError.at.getTime(), source: lastLogError.source, message: lastLogError.message, meta: lastLogError.meta ?? null }
      : null,
    version: buildVersion(),
  });
}

function buildVersion() {
  return {
    // Render injects the deployed commit; null when running elsewhere.
    commit: process.env.RENDER_GIT_COMMIT ?? null,
    node: process.version,
    prisma: PrismaRuntime.prismaVersion.client,
  };
}
