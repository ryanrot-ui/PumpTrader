import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * EngineState is a single database row ("engine") that both processes share:
 * the worker writes status/heartbeat/health, the web app reads them and
 * writes control requests (emergency stop / resume, read-only). Using the DB
 * as the source of truth means the platform needs no Redis to function.
 */

export const ENGINE_STATE_ID = "engine";

/**
 * Heartbeats older than this mean the engine is down or wedged. The margin
 * covers the serverless deployment model too: engine cycles run as bounded
 * background jobs relaunched by a per-minute scheduler, so up to ~60s can
 * pass between the end of one cycle and the start of the next.
 */
export const HEARTBEAT_STALE_MS = 90_000;

/**
 * Serverless engine lease. A new engine cycle may start when the current
 * state is not "running" or its heartbeat is older than this. Shorter than
 * HEARTBEAT_STALE_MS so a wedged runner is replaced before the dashboard
 * has long declared the engine dead; comfortably longer than the runner's
 * 5s heartbeat interval so a healthy runner is never duplicated.
 */
export const ENGINE_LEASE_MS = 45_000;

export function engineLeaseAvailable(
  state: { status: string; heartbeatAt: Date | null } | null
): boolean {
  if (!state) return true;
  if (state.status !== "running" && state.status !== "emergency_stopped") return true;
  return (
    state.heartbeatAt == null ||
    Date.now() - state.heartbeatAt.getTime() > ENGINE_LEASE_MS
  );
}

/**
 * Atomically claim the engine lease (conditional update — safe against
 * concurrent claimants). Exactly one engine cycle may hold the lease: live
 * trading with two engines monitoring the same positions could double-sell.
 * A cleanly-ended cycle ("idle"/"stopped") or a stale heartbeat (crashed or
 * wedged runner) is claimable; a fresh "running"/"emergency_stopped"
 * heartbeat is not.
 */
export async function claimEngineLease(): Promise<boolean> {
  await prisma.engineState
    .createMany({ data: [{ id: ENGINE_STATE_ID }], skipDuplicates: true })
    .catch(() => {});
  const res = await prisma.engineState.updateMany({
    where: {
      id: ENGINE_STATE_ID,
      OR: [
        { status: { in: ["idle", "stopped"] } },
        { heartbeatAt: null },
        { heartbeatAt: { lt: new Date(Date.now() - ENGINE_LEASE_MS) } },
      ],
    },
    data: { status: "running", heartbeatAt: new Date() },
  });
  return res.count > 0;
}

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
