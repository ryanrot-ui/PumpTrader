import { prisma } from "@/lib/prisma";
import { redis, KEYS } from "@/lib/redis";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "scanner" | "scoring" | "executor" | "risk" | "api" | "notify" | "engine";

/**
 * Structured logger: console + database + Redis pub/sub (for the dashboard
 * live feed). DB writes are fire-and-forget so logging never blocks trading.
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

  void prisma.logEntry
    .create({ data: { level, source, message, meta: meta ? JSON.parse(JSON.stringify(meta)) : undefined } })
    .catch(() => {});

  void redis
    .publish(
      KEYS.liveFeed,
      JSON.stringify({ at: Date.now(), level, source, message, meta })
    )
    .catch(() => {});
}

export const logger = {
  debug: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("debug", s, m, meta),
  info: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("info", s, m, meta),
  warn: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("warn", s, m, meta),
  error: (s: LogSource, m: string, meta?: Record<string, unknown>) => log("error", s, m, meta),
};
