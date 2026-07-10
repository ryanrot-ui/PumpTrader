import { createHash } from "crypto";

/**
 * Binds manual-trade submission (step 2) to a transaction the server built
 * (step 1). The build step registers the SHA-256 of the unsigned message;
 * the submit step must present a signed transaction whose message hash is
 * pending, and the hash is consumed on success.
 *
 * This guarantees:
 *  - the submit endpoint cannot be used as an open relay for arbitrary
 *    transactions — only server-built Jupiter swaps pass
 *  - the recorded trade metadata (mint/side/amount) matches what was built
 *  - the same signed transaction cannot be submitted twice through this
 *    endpoint (double-click / retry protection)
 *
 * In-memory by design: the app targets a single web instance (see
 * DEPLOY-RENDER.md); entries expire after TTL_MS.
 */

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;

interface PendingBuild {
  userId: string;
  mint: string;
  side: "buy" | "sell";
  /** SOL committed (buy) or expected SOL out (sell) — derived server-side. */
  amountSol: number;
  expiresAt: number;
}

const pending = new Map<string, PendingBuild>();

/** Signing never alters the message, so this hash survives Phantom's signature. */
export function txMessageHash(serializedMessage: Uint8Array): string {
  return createHash("sha256").update(serializedMessage).digest("hex");
}

export function registerBuiltTx(
  hash: string,
  build: { userId: string; mint: string; side: "buy" | "sell"; amountSol: number }
): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
  if (pending.size >= MAX_PENDING) pending.clear(); // cap memory; builds are cheap to redo
  pending.set(hash, { ...build, expiresAt: now + TTL_MS });
}

/**
 * Validate and consume a pending build. Returns the registered metadata or
 * null when the hash is unknown, expired, or belongs to another user.
 */
export function consumeBuiltTx(
  hash: string,
  userId: string
): { mint: string; side: "buy" | "sell"; amountSol: number } | null {
  const entry = pending.get(hash);
  if (!entry || entry.expiresAt <= Date.now() || entry.userId !== userId) return null;
  pending.delete(hash);
  return { mint: entry.mint, side: entry.side, amountSol: entry.amountSol };
}
