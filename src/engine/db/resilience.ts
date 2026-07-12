import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Database resilience for running 24/7 on a database that can briefly
 * disappear (Neon Free suspends/wakes computes; connections drop).
 *
 * Circuit breaker: the FIRST transient failure marks the database offline.
 * While offline, no per-token Prisma calls are attempted — the scanner keeps
 * detecting and the scorer keeps scoring, with their writes captured in a
 * bounded in-memory queue. The engine's 5-second state tick doubles as the
 * probe, attempted on an exponential backoff (5s → 10s → 20s → 40s → 60s
 * cap — periodic, never hot-looping, never giving up). The first successful
 * probe flushes the queue in arrival order with the ORIGINAL timestamps and
 * resumes normal persistence.
 *
 * What is queued (safe): append-only history — token detections (deduped by
 * mint; the DB's unique(mint) is the second line of defense) and
 * score/snapshot records (with their capture-time `at`, so history stays
 * truthful). What is NOT queued (unsafe): verdict/state updates and trades.
 * Verdicts are last-write-wins state — replaying a stale verdict after
 * recovery could overwrite a newer evaluation, so the next live cycle simply
 * recomputes them. Trades are never queued: a swap decision made against
 * market data from during the outage must not execute minutes later.
 */

const TRANSIENT_CODES = new Set([
  "P1001", // can't reach database server
  "P1002", // server reached but timed out
  "P1008", // operation timed out
  "P1017", // server closed the connection
]);

export function isTransientDbError(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  if (err?.code && TRANSIENT_CODES.has(err.code)) return true;
  return /Can't reach database server|Connection refused|ECONNREFUSED|ETIMEDOUT|Timed out fetching|Closed the connection|Connection terminated/i.test(
    err?.message ?? ""
  );
}

export interface QueuedDetection {
  mint: string;
  poolAddress: string | null;
  migratedAt: Date;
}

export interface QueuedScoreWrite {
  tokenId: string;
  mint: string;
  at: Date; // capture time — preserved on flush so history stays honest
  score: {
    total: number;
    breakdown: Prisma.InputJsonValue;
    greenFlags: string[];
    redFlags: string[];
    critical: boolean;
  };
  snapshot: {
    priceUsd: number | null;
    liquiditySol: number | null;
    marketCapUsd: number | null;
    volume5mUsd: number | null;
    holderCount: number | null;
    txPerMinute: number | null;
    buySellRatio: number | null;
  };
}

const MAX_QUEUED_SCORES = 500;
const PROBE_MIN_MS = 5_000;
const PROBE_MAX_MS = 60_000;
/** While offline, re-log the status line at most this often. */
const STATUS_LOG_EVERY_MS = 60_000;

export class DbResilience {
  private openedAt: number | null = null; // null = circuit closed (healthy)
  private consecutiveFailures = 0;
  private probeDelayMs = PROBE_MIN_MS;
  private nextProbeAt = 0;
  private lastStatusLogAt = 0;
  lastSuccessAt: number | null = null;
  lastFailureAt: number | null = null;
  lastFailureReason: string | null = null;
  droppedWrites = 0;

  private detectionQueue = new Map<string, QueuedDetection>(); // keyed by mint (dedupe)
  private scoreQueue: QueuedScoreWrite[] = []; // FIFO

  /** Called after a queued detection is flushed, so the engine can watch it. */
  onDetectionFlushed: (tokenId: string, d: QueuedDetection) => void = () => {};
  /** DB-independent log sink (console) — never writes to the database. */
  private log(line: string): void {
    console.warn(line);
  }

  get healthy(): boolean {
    return this.openedAt === null;
  }
  get queueSize(): number {
    return this.detectionQueue.size + this.scoreQueue.length;
  }
  get retries(): number {
    return this.consecutiveFailures;
  }
  get nextRetryInMs(): number | null {
    return this.openedAt !== null ? Math.max(0, this.nextProbeAt - Date.now()) : null;
  }

  /** True when the offline circuit should attempt its next probe. */
  probeDue(now = Date.now()): boolean {
    return this.openedAt !== null && now >= this.nextProbeAt;
  }

  recordFailure(e: unknown, now = Date.now()): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = now;
    this.lastFailureReason =
      ((e as Error).message ?? "unknown")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .find((l) => !l.startsWith("Invalid ")) ?? "unknown";

    const firstFailure = this.openedAt === null;
    if (firstFailure) this.openedAt = now;
    // Exponential backoff, capped — periodic retries forever, hot loops never.
    this.probeDelayMs = Math.min(PROBE_MIN_MS * 2 ** Math.min(this.consecutiveFailures - 1, 10), PROBE_MAX_MS);
    this.nextProbeAt = now + this.probeDelayMs;

    if (firstFailure || now - this.lastStatusLogAt >= STATUS_LOG_EVERY_MS) {
      this.lastStatusLogAt = now;
      this.log(
        `[database] status: OFFLINE — ${this.lastFailureReason}; retries: ${this.consecutiveFailures}; ` +
          `queued writes: ${this.queueSize}; next retry in ${Math.round(this.probeDelayMs / 1000)}s`
      );
    }
  }

  /** On success: close the circuit and flush queues (first success only). */
  async recordSuccess(now = Date.now()): Promise<void> {
    this.lastSuccessAt = now;
    if (this.openedAt === null) return; // was healthy — nothing to do
    const downForS = Math.round((now - this.openedAt) / 1000);
    this.openedAt = null;
    this.consecutiveFailures = 0;
    this.probeDelayMs = PROBE_MIN_MS;

    const { flushedDetections, flushedScores, failed } = await this.flush();
    this.log(
      `[database] connection restored after ${downForS}s — ` +
        `${flushedDetections} queued detection(s) and ${flushedScores} queued score write(s) flushed` +
        `${failed > 0 ? ` (${failed} skipped)` : ""}${this.droppedWrites > 0 ? `; ${this.droppedWrites} dropped while offline` : ""} — engine resumed`
    );
    this.droppedWrites = 0;
  }

  enqueueDetection(d: QueuedDetection): void {
    this.detectionQueue.set(d.mint, d); // dedupe by mint
  }

  enqueueScore(w: QueuedScoreWrite): void {
    if (this.scoreQueue.length >= MAX_QUEUED_SCORES) {
      this.scoreQueue.shift(); // drop the oldest — newest data matters most
      this.droppedWrites += 1;
    }
    this.scoreQueue.push(w);
  }

  /**
   * Flush queues in order: detections first (score writes may reference
   * them), then score history FIFO with original timestamps. Every entry is
   * isolated — one bad row is skipped, the rest still land. unique(mint) and
   * per-entry error handling make the flush idempotent and duplicate-free.
   */
  private async flush(): Promise<{ flushedDetections: number; flushedScores: number; failed: number }> {
    let flushedDetections = 0;
    let flushedScores = 0;
    let failed = 0;

    const detections = [...this.detectionQueue.values()];
    this.detectionQueue.clear();
    for (const d of detections) {
      try {
        const existing = await prisma.detectedToken.findUnique({ where: { mint: d.mint } });
        const row =
          existing ??
          (await prisma.detectedToken.create({
            data: { mint: d.mint, poolAddress: d.poolAddress, migratedAt: d.migratedAt, verdict: null },
          }));
        this.onDetectionFlushed(row.id, d);
        flushedDetections += 1;
      } catch {
        failed += 1;
      }
    }

    const scores = [...this.scoreQueue];
    this.scoreQueue = [];
    for (const w of scores) {
      try {
        await prisma.$transaction([
          prisma.scoreRecord.create({ data: { tokenId: w.tokenId, at: w.at, ...w.score } }),
          prisma.tokenSnapshot.create({ data: { tokenId: w.tokenId, at: w.at, ...w.snapshot } }),
        ]);
        flushedScores += 1;
      } catch {
        failed += 1; // e.g. token row archived meanwhile — skip, keep going
      }
    }

    return { flushedDetections, flushedScores, failed };
  }

  /** Diagnostics snapshot (published in the engine health heartbeat). */
  snapshot() {
    return {
      dbStatus: this.healthy ? ("up" as const) : ("down" as const),
      dbConsecutiveFailures: this.consecutiveFailures,
      dbLastSuccessAt: this.lastSuccessAt,
      dbLastFailureAt: this.lastFailureAt,
      dbLastFailureReason: this.lastFailureReason,
      dbNextRetryInMs: this.nextRetryInMs,
      dbQueuedWrites: this.queueSize,
    };
  }
}

export const dbResilience = new DbResilience();
