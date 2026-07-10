import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { engineAlive, getEngineState, type EngineHealth } from "@/lib/engineState";
import { unauthorized } from "@/lib/session";

/** Engine health & telemetry for the dashboard health strip. */
export async function GET() {
  // JWT-only auth (no DB round-trip): this endpoint must keep answering when
  // the database is unreachable — that outage is exactly what it reports.
  const session = await getServerSession(authOptions);
  const uid = (session?.user as { id?: string } | undefined)?.id;
  if (!uid) return unauthorized();

  let state: Awaited<ReturnType<typeof getEngineState>>;
  let lastErrorEntry: { at: Date; source: string; message: string } | null;
  try {
    [state, lastErrorEntry] = await Promise.all([
      getEngineState(),
      prisma.logEntry.findFirst({
        where: { level: "error", at: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        orderBy: { at: "desc" },
        select: { at: true, source: true, message: true },
      }),
    ]);
  } catch (e) {
    // Database unreachable (Neon compute suspended / stale DATABASE_URL /
    // network). Report it as a first-class state instead of a 500: without
    // this the dashboard blames the engine worker for what is a DB outage.
    // Prefer the human-readable cause ("Can't reach database server at …")
    // over Prisma's "Invalid `prisma.x()` invocation:" preamble, falling back
    // to the error code (`code` on request errors, `errorCode` on init errors).
    const err = e as Error & { code?: string; errorCode?: string };
    const lines = (err.message ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    const detail = lines.find((l) => !l.startsWith("Invalid ")) ?? lines[0];
    return NextResponse.json({
      dbConnected: false,
      dbError: detail ?? err.code ?? err.errorCode ?? "unreachable",
      engineAlive: false,
      status: "unknown",
      readOnly: false,
      rpcUrl: null,
      rpcLatencyMs: null,
      rpcFailures: null,
      scannerLastEventAt: null,
      scansPerMin: null,
      watchlistSize: null,
      lastTradeAt: null,
      memoryRssMb: null,
      memoryHeapMb: null,
      rpcConnected: false,
      scannerSubscribed: null,
      lastScanAt: null,
      lastPollCount: null,
      wsConnected: null,
      usingPublicRpc: null,
      tokensDetected: null,
      scannerError: null,
      lastError: null,
    });
  }

  const health = (state?.health ?? {}) as EngineHealth;

  return NextResponse.json({
    dbConnected: true,
    dbError: null,
    engineAlive: engineAlive(state?.heartbeatAt),
    status: state?.status ?? "stopped",
    readOnly: state?.readOnly ?? false,
    rpcUrl: health.rpcUrl ?? null,
    rpcLatencyMs: health.rpcLatencyMs ?? null,
    rpcFailures: health.rpcFailures ?? null,
    scannerLastEventAt: health.scannerLastEventAt ?? null,
    scansPerMin: health.scansPerMin ?? null,
    watchlistSize: health.watchlistSize ?? null,
    lastTradeAt: health.lastTradeAt ?? null,
    memoryRssMb: health.rssMb ?? null,
    memoryHeapMb: health.heapMb ?? null,
    // scanner observability (Engine Running / RPC Connected / Scanner Active /
    // Last Scan / Tokens Detected indicators on the dashboard)
    rpcConnected: health.rpcLatencyMs != null,
    scannerSubscribed: health.scannerSubscribed ?? null,
    lastScanAt: health.lastScanAt ?? null,
    lastPollCount: health.lastPollCount ?? null,
    wsConnected: health.wsConnected ?? null,
    usingPublicRpc: health.usingPublicRpc ?? null,
    tokensDetected: health.tokensDetected ?? null,
    scannerError: health.scannerError ?? null,
    lastError: lastErrorEntry
      ? { at: lastErrorEntry.at.getTime(), source: lastErrorEntry.source, message: lastErrorEntry.message }
      : null,
  });
}
