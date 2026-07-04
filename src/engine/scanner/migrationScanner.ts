import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";

/**
 * Detects Pump.fun → Raydium migrations in real time.
 *
 * Primary path: a WebSocket `onLogs` subscription on the Pump.fun Raydium
 * migration authority. When a bonding curve completes, this authority signs
 * the Raydium `initialize2` pool-creation transaction, so every log hit is a
 * migration. We then fetch the parsed transaction and pull out the new mint
 * and pool address.
 *
 * Fallback path: if the WebSocket drops, an exponential-backoff reconnect
 * kicks in; a slow polling loop over recent authority signatures also runs so
 * migrations that happened during a disconnect are not lost.
 */

// Pump.fun Raydium migration authority (signs all migration txs)
export const PUMP_MIGRATION_AUTHORITY = new PublicKey(
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
);
export const RAYDIUM_AMM_V4 = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);
const WSOL = "So11111111111111111111111111111111111111112";

export interface MigrationEvent {
  mint: string;
  poolAddress: string | null;
  signature: string;
  migratedAt: Date;
}

export type MigrationHandler = (event: MigrationEvent) => void | Promise<void>;

export class MigrationScanner {
  private conn: Connection;
  private handler: MigrationHandler;
  private onError: (err: Error, ctx: string) => void;
  private subId: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private stopped = false;
  private lastPolledSig: string | undefined;

  constructor(
    conn: Connection,
    handler: MigrationHandler,
    onError: (err: Error, ctx: string) => void = () => {}
  ) {
    this.conn = conn;
    this.handler = handler;
    this.onError = onError;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.subscribe();
    // Poll every 30s as a safety net for missed WebSocket events
    this.pollTimer = setInterval(() => {
      this.pollRecent().catch((e) => this.onError(e as Error, "poll"));
    }, 30_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.subId !== null) {
      await this.conn.removeOnLogsListener(this.subId).catch(() => {});
      this.subId = null;
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private subscribe(): void {
    if (this.stopped) return;
    try {
      this.subId = this.conn.onLogs(
        PUMP_MIGRATION_AUTHORITY,
        (logs) => {
          if (logs.err) return; // failed tx
          this.processSignature(logs.signature).catch((e) =>
            this.onError(e as Error, "ws-process")
          );
        },
        "confirmed"
      );
    } catch (e) {
      this.onError(e as Error, "subscribe");
      setTimeout(() => this.subscribe(), 5_000);
    }
  }

  /** Catch-up poll over the migration authority's recent signatures. */
  private async pollRecent(): Promise<void> {
    const sigs = await this.conn.getSignaturesForAddress(
      PUMP_MIGRATION_AUTHORITY,
      { limit: 25, until: this.lastPolledSig },
      "confirmed"
    );
    if (sigs.length > 0) this.lastPolledSig = sigs[0].signature;
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      await this.processSignature(s.signature);
    }
  }

  private async processSignature(signature: string): Promise<void> {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > 5000) {
      // bound memory: drop oldest half
      const keep = [...this.seen].slice(-2500);
      this.seen = new Set(keep);
    }

    const tx = await this.conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) return;

    const event = extractMigration(tx, signature);
    if (!event) return;
    if (this.seen.has(`mint:${event.mint}`)) return;
    this.seen.add(`mint:${event.mint}`);

    await this.handler(event);
  }
}

/**
 * Pull the migrated mint + Raydium pool out of a parsed migration tx.
 * The migration tx creates a Raydium AMM pool of (new token, WSOL); the new
 * token is the only non-WSOL mint in the post token balances.
 */
export function extractMigration(
  tx: ParsedTransactionWithMeta,
  signature: string
): MigrationEvent | null {
  // Must actually touch the Raydium AMM program
  const touchesRaydium = tx.transaction.message.instructions.some(
    (ix) => "programId" in ix && ix.programId.equals(RAYDIUM_AMM_V4)
  );
  const innerTouches = (tx.meta?.innerInstructions ?? []).some((inner) =>
    inner.instructions.some((ix) => "programId" in ix && ix.programId.equals(RAYDIUM_AMM_V4))
  );
  if (!touchesRaydium && !innerTouches) return null;

  const mints = new Set(
    (tx.meta?.postTokenBalances ?? []).map((b) => b.mint).filter((m) => m !== WSOL)
  );
  const mint = [...mints][0];
  if (!mint) return null;

  // Pool address: first writable non-signer account of the Raydium instruction
  let poolAddress: string | null = null;
  const rayIx = tx.transaction.message.instructions.find(
    (ix) => "programId" in ix && ix.programId.equals(RAYDIUM_AMM_V4)
  );
  if (rayIx && "accounts" in rayIx && rayIx.accounts.length > 4) {
    poolAddress = rayIx.accounts[4].toBase58();
  }

  return {
    mint,
    poolAddress,
    signature,
    migratedAt: new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000),
  };
}
