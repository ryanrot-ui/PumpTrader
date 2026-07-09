import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { engineAlive, getEngineState, type EngineHealth } from "@/lib/engineState";
import { requireUser, unauthorized } from "@/lib/session";

/** Engine health & telemetry for the dashboard health strip. */
export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const [state, lastErrorEntry] = await Promise.all([
    getEngineState(),
    prisma.logEntry.findFirst({
      where: { level: "error", at: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { at: "desc" },
      select: { at: true, source: true, message: true },
    }),
  ]);

  const health = (state?.health ?? {}) as EngineHealth;

  return NextResponse.json({
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
