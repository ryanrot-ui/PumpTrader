/**
 * Connection-string tuning and verification for Neon (and Neon-compatible)
 * PostgreSQL URLs. Pure functions — unit-tested in tests/dbUrl.test.ts.
 *
 * Why tuning is needed on Neon Free: a suspended compute wakes on the first
 * connection attempt, which can take several seconds. Prisma's default
 * connect_timeout is 5s — short enough that the very query that WAKES the
 * database is reported as "Can't reach database server", opening the circuit
 * for an outage that isn't one. Raising the timeout (only when the operator
 * hasn't set one) rides out the wake instead.
 */

const DEFAULT_PARAMS: Record<string, string> = {
  // Ride out a Neon compute cold-start instead of failing the waking query.
  connect_timeout: "15",
  // Waiting for a pool slot slightly longer beats a spurious P2024 while the
  // first post-wake connections are still being established.
  pool_timeout: "15",
};

/**
 * Apply Neon-friendly defaults to a postgres URL without overriding anything
 * the operator configured explicitly (existing query params always win).
 * `DB_CONNECTION_LIMIT` (env) caps Prisma's pool size per process — useful to
 * keep the web + engine well under Neon Free's connection budget.
 */
export function tuneDbUrl(raw: string, env: Record<string, string | undefined> = process.env): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // malformed → let Prisma produce its own (clear) error
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return raw;

  for (const [key, value] of Object.entries(DEFAULT_PARAMS)) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  const limit = env.DB_CONNECTION_LIMIT?.trim();
  if (limit && /^\d+$/.test(limit) && !url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", limit);
  }
  return url.toString();
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

export function isNeonHost(raw: string): boolean {
  return /\.neon\.tech$/i.test(hostOf(raw) ?? "");
}

export function isNeonPooledUrl(raw: string): boolean {
  const host = hostOf(raw) ?? "";
  return /\.neon\.tech$/i.test(host) && /-pooler\./i.test(host);
}

/**
 * Misconfiguration warnings for the DATABASE_URL / DIRECT_URL pair. Returns
 * human-readable lines (empty when everything looks right). Logged once at
 * client creation so both the web app and the engine surface them.
 */
export function neonConfigWarnings(
  databaseUrl: string | undefined,
  directUrl: string | undefined
): string[] {
  const warnings: string[] = [];
  if (databaseUrl && isNeonHost(databaseUrl) && !isNeonPooledUrl(databaseUrl)) {
    warnings.push(
      "DATABASE_URL points at Neon's DIRECT endpoint. Runtime queries should use the POOLED " +
        "endpoint (hostname contains '-pooler') — the direct endpoint has a small connection limit " +
        "and will exhaust under the web app + engine. Copy the 'Pooled connection' string from the Neon console."
    );
  }
  if (directUrl && isNeonPooledUrl(directUrl)) {
    warnings.push(
      "DIRECT_URL points at Neon's POOLED endpoint ('-pooler'). Schema application (prisma db push) " +
        "needs the direct endpoint — remove '-pooler' from the hostname, or unset DIRECT_URL and let " +
        "the container derive it from DATABASE_URL."
    );
  }
  return warnings;
}
