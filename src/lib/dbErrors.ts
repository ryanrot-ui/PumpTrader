/**
 * Transient database-failure classification, shared by the web app and the
 * engine. "Transient" means the database itself is (briefly) unreachable —
 * exactly what happens when a Neon Free compute suspends, wakes, or drops
 * pooled connections — as opposed to data/constraint errors, which retrying
 * can never fix.
 */

const TRANSIENT_CODES = new Set([
  "P1001", // can't reach database server
  "P1002", // server reached but timed out
  "P1008", // operation timed out
  "P1017", // server closed the connection
]);

export function isTransientDbError(e: unknown): boolean {
  const err = e as { code?: string; errorCode?: string; message?: string };
  if (err?.code && TRANSIENT_CODES.has(err.code)) return true;
  // PrismaClientInitializationError carries errorCode instead of code.
  if (err?.errorCode && TRANSIENT_CODES.has(err.errorCode)) return true;
  return /Can't reach database server|Connection refused|ECONNREFUSED|ETIMEDOUT|Timed out fetching|Closed the connection|Connection terminated|Server has closed the connection/i.test(
    err?.message ?? ""
  );
}

/**
 * The one human-readable line out of a multi-line Prisma error — the actual
 * cause ("Can't reach database server at …"), never the "Invalid
 * `prisma.x()` invocation:" preamble.
 */
export function dbErrorSummary(e: unknown): string {
  const err = e as Error & { code?: string; errorCode?: string };
  const lines = (err?.message ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.find((l) => !l.startsWith("Invalid ")) ?? lines[0] ?? err?.code ?? err?.errorCode ?? "unknown";
}
