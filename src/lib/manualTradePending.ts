import { createHash } from "crypto";
import { prisma } from "./prisma";

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
 * Database-backed: on serverless deployments the build and submit requests
 * can land on different function instances, so the registry must be shared.
 * Consumption is a row delete on the unique hash — atomic, exactly one
 * submit can ever win.
 */

const TTL_MS = 10 * 60_000;

/** Signing never alters the message, so this hash survives Phantom's signature. */
export function txMessageHash(serializedMessage: Uint8Array): string {
  return createHash("sha256").update(serializedMessage).digest("hex");
}

export async function registerBuiltTx(
  hash: string,
  build: { userId: string; mint: string; side: "buy" | "sell" }
): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_MS);
  // Opportunistic cleanup of expired entries (cheap, indexed).
  await prisma.pendingManualTrade
    .deleteMany({ where: { expiresAt: { lte: new Date() } } })
    .catch(() => {});
  // Upsert: rebuilding the same swap refreshes the entry.
  await prisma.pendingManualTrade.upsert({
    where: { hash },
    update: { ...build, expiresAt },
    create: { hash, ...build, expiresAt },
  });
}

/**
 * Validate and consume a pending build. Returns the registered metadata or
 * null when the hash is unknown, expired, already consumed, or belongs to
 * another user.
 */
export async function consumeBuiltTx(
  hash: string,
  userId: string
): Promise<{ mint: string; side: "buy" | "sell" } | null> {
  // Atomic single-use: the delete succeeds for exactly one caller.
  const entry = await prisma.pendingManualTrade.delete({ where: { hash } }).catch(() => null);
  if (!entry || entry.userId !== userId || entry.expiresAt.getTime() <= Date.now()) return null;
  return { mint: entry.mint, side: entry.side as "buy" | "sell" };
}
