import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * Phantom wallet ownership verification.
 *
 * Connecting a wallet only proves the extension reported an address; before
 * we persist it for the account, the user signs a human-readable message
 * with that wallet (Phantom's signMessage prompt) and the server verifies
 * the ed25519 signature. This prevents linking arbitrary addresses and gives
 * the operator a clear, phishing-resistant prompt ("Sign to verify…" with no
 * transaction and no fee).
 */

const MESSAGE_PREFIX = "PumpTrader wallet verification";
/** Signed messages older than this are rejected (replay window). */
const MAX_AGE_MS = 10 * 60_000;

export function buildVerificationMessage(userId: string, issuedAt: number): string {
  return `${MESSAGE_PREFIX}\naccount: ${userId}\nissued: ${new Date(issuedAt).toISOString()}\n\nSigning is free and sends no transaction.`;
}

export interface WalletProof {
  publicKey: string; // base58
  message: string; // exact signed message
  signature: string; // base58 ed25519 signature
}

export function verifyWalletProof(
  proof: WalletProof,
  expectedUserId: string,
  now: number = Date.now()
): { ok: true } | { ok: false; reason: string } {
  const lines = proof.message.split("\n");
  if (lines[0] !== MESSAGE_PREFIX) return { ok: false, reason: "unexpected message format" };
  if (lines[1] !== `account: ${expectedUserId}`) {
    return { ok: false, reason: "message was issued for a different account" };
  }
  const issuedAt = Date.parse(lines[2]?.replace("issued: ", "") ?? "");
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > MAX_AGE_MS) {
    return { ok: false, reason: "verification message expired — reconnect and sign again" };
  }

  // nacl throws on wrong-length inputs (rather than returning false), so the
  // whole decode+verify is treated as one fallible step.
  let valid = false;
  try {
    valid = nacl.sign.detached.verify(
      new TextEncoder().encode(proof.message),
      bs58.decode(proof.signature),
      new PublicKey(proof.publicKey).toBytes()
    );
  } catch {
    return { ok: false, reason: "malformed public key or signature" };
  }
  return valid ? { ok: true } : { ok: false, reason: "signature does not match the wallet" };
}
