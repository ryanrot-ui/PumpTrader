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
