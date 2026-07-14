import { prisma } from "@/lib/prisma";
import { publish, CHANNELS } from "@/lib/redis";
import { dbResilience } from "@/engine/db/resilience";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "scanner" | "scoring" | "executor" | "risk" | "api" | "notify" | "engine";

/**
 * Structured logger: console + database + live-feed publish (no-op without
 * Redis — the dashboard feed then polls the log table instead). DB writes are
 * fire-and-forget so logging never blocks trading. The dashboard's
 * "last error" indicator reads the newest error-level LogEntry.
 */
export function log(
  level: LogLevel,
  source: LogSource,
  message: string,
  meta?: Record<string, unknown>
): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${source}] ${message}`;
  if (level === "error") console.error(line, meta ?? "");
  else if (level === "warn") console.warn(line, meta ?? "");
  else console.log(line, meta ?? "");

  // debug stays console-only: persisting per-token debug chatter is the
  // single biggest source of avoidable write volume on a free-tier database.
  // While the circuit is open the DB persist is skipped entirely — every log
  // line would otherwise fire one more doomed connection attempt at a
  // database we already know is down (console + live feed still record it;
  // log rows are deliberately not queued: low-value bulk that would crowd
  // the offline queue and replay as a write burst on recovery).
  if (level !== "debug" && dbResilience.healthy) {
    void prisma.logEntry
      .create({ data: { level, source, message, meta: meta ? JSON.parse(JSON.stringify(meta)) : undefined } })
      .catch(() => {});
  }

  publish(CHANNELS.liveFeed, JSON.stringify({ at: Date.now(), level, source, message, meta }));
}

export const logger = {
  debug: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("debug", s, m, meta),
  info: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("info", s, m, meta),
  warn: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("warn", s, m, meta),
  error: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("error", s, m, meta),
  /** Error with full stack trace attached — no silent failures. */
  exception: (s: LogSource, m: string, err: unknown, meta?: Record<string, unknown>) => {
    const e = err instanceof Error ? err : new Error(String(err));
    log("error", s, `${m}: ${e.message}`, { ...meta, stack: e.stack });
  },
};
