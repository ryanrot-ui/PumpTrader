import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * EngineState is a single database row ("engine") that both processes share:
 * the worker writes status/heartbeat/health, the web app reads them and
 * writes control requests (emergency stop / resume, read-only). Using the DB
 * as the source of truth means the platform needs no Redis to function.
 */

export const ENGINE_STATE_ID = "engine";

/** Heartbeats older than this mean the worker is down or wedged. */
export const HEARTBEAT_STALE_MS = 20_000;

export interface EngineHealth {
  rpcUrl?: string;
  rpcLatencyMs?: number | null;
  rpcFailures?: number;
  scannerLastEventAt?: number;
  scansPerMin?: number;
  watchlistSize?: number;
  lastTradeAt?: number | null;
  rssMb?: number;
  heapMb?: number;
  // ── scanner observability ────────────────────────────────────────────────
  /** true when the realtime onLogs subscription id is held. */
  scannerSubscribed?: boolean;
  /** epoch ms of the last completed poll cycle (reliable HTTP fallback). */
  lastScanAt?: number | null;
  /** signatures seen in the last poll cycle. */
  lastPollCount?: number;
  /** true when the migration-authority websocket has not errored recently. */
  wsConnected?: boolean;
  /** true when running against the public mainnet RPC (no dedicated endpoint). */
  usingPublicRpc?: boolean;
  /** total DetectedToken rows (the "Tokens Detected" indicator). */
  tokensDetected?: number;
  /** last scanner poll error (rate limit / unreachable), if any. */
  scannerError?: string | null;
  /** updatedAt (epoch ms) of the settings row the engine currently runs on. */
  settingsLoadedAt?: number | null;
  // ── RPC endpoint health (per-endpoint scoring + failover history) ────────
  rpcEndpoints?: Array<{
    url: string;
    active: boolean;
    health: number;
    latencyMs: number | null;
    timeouts: number;
    failures: number;
    lastSuccessAt: number | null;
    lastError: string | null;
  }>;
  rpcHealth?: number | null;
  rpcTimeouts?: number;
  rpcLastSuccessAt?: number | null;
  rpcFailoverHistory?: Array<{ at: number; from: string; to: string; reason: string }>;
  // ── database circuit breaker (engine-side Neon resilience) ───────────────
  dbStatus?: "up" | "down";
  dbConsecutiveFailures?: number;
  dbLastSuccessAt?: number | null;
  dbLastFailureAt?: number | null;
  dbLastFailureReason?: string | null;
  dbNextRetryInMs?: number | null;
  dbQueuedWrites?: number;
}

export async function getEngineState() {
  return prisma.engineState.findUnique({ where: { id: ENGINE_STATE_ID } });
}

export async function updateEngineState(
  data: Prisma.EngineStateUpdateInput
): Promise<void> {
  await prisma.engineState.upsert({
    where: { id: ENGINE_STATE_ID },
    update: data,
    create: { id: ENGINE_STATE_ID, ...(data as Prisma.EngineStateCreateInput) },
  });
}

/** Queue a one-shot control command for the engine (consumed within ~5s). */
export async function requestEngineControl(command: "emergency_stop" | "resume"): Promise<void> {
  await updateEngineState({ controlRequest: command, controlRequestedAt: new Date() });
}

export function engineAlive(heartbeatAt: Date | null | undefined): boolean {
  return heartbeatAt != null && Date.now() - heartbeatAt.getTime() < HEARTBEAT_STALE_MS;
}
