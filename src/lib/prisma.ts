import { PrismaClient } from "@prisma/client";
import { tuneDbUrl, neonConfigWarnings } from "./dbUrl";

/**
 * One shared Prisma client per process.
 *
 * - Reused across hot reloads in dev and across route handlers in prod —
 *   Prisma opens a connection pool per client, so extra clients mean extra
 *   connections against Neon's budget.
 * - The datasource URL gets Neon-friendly defaults (longer connect_timeout so
 *   the query that WAKES a suspended Neon Free compute doesn't itself time
 *   out; see lib/dbUrl.ts). Operator-set params always win.
 * - Error logging is event-based and de-duplicated: during an outage every
 *   query fails with the same "Can't reach database server …" — that becomes
 *   ONE line per minute with a repeat count, not hundreds of identical blocks.
 */

type LoggedPrismaClient = PrismaClient<
  { log: [{ emit: "event"; level: "error" }, { emit: "event"; level: "warn" }] },
  "error" | "warn"
>;

const SUPPRESS_MS = 60_000;
const recentLogs = new Map<string, { count: number; lastLoggedAt: number }>();

/** Log a message now; suppress identical messages for the next 60s, then
 *  report how many were suppressed. Keeps genuinely different errors loud. */
function throttled(kind: "error" | "warn", message: string): void {
  const now = Date.now();
  const entry = recentLogs.get(message);
  if (entry && now - entry.lastLoggedAt < SUPPRESS_MS) {
    entry.count += 1;
    return;
  }
  const repeats = entry?.count ?? 0;
  const suffix = repeats > 0 ? ` (repeated ${repeats}× in the last ${Math.round(SUPPRESS_MS / 1000)}s)` : "";
  (kind === "error" ? console.error : console.warn)(`[database] ${message}${suffix}`);
  recentLogs.set(message, { count: 0, lastLoggedAt: now });
  if (recentLogs.size > 200) {
    for (const [k, v] of recentLogs) if (now - v.lastLoggedAt > SUPPRESS_MS) recentLogs.delete(k);
  }
}

function createClient(): LoggedPrismaClient {
  const rawUrl = process.env.DATABASE_URL;
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
    // Only override the datasource when DATABASE_URL exists — with it unset
    // the client must still construct (the web container boots and warns).
    ...(rawUrl ? { datasources: { db: { url: tuneDbUrl(rawUrl) } } } : {}),
  }) as LoggedPrismaClient;

  client.$on("error", (e) => throttled("error", e.message));
  client.$on("warn", (e) => {
    if (process.env.NODE_ENV === "development") throttled("warn", e.message);
  });

  // One-time pooled-vs-direct sanity check so a misconfigured Neon URL pair
  // is called out at boot instead of discovered as a 3am outage.
  for (const warning of neonConfigWarnings(rawUrl, process.env.DIRECT_URL)) {
    console.warn(`[database] configuration warning: ${warning}`);
  }
  return client;
}

const globalForPrisma = globalThis as unknown as { prisma?: LoggedPrismaClient };

export const prisma: LoggedPrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
