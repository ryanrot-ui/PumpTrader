import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { withRpcRetry } from "../rpc/health";

/**
 * Detects Pump.fun bonding-curve graduations ("migrations") in real time.
 *
 * Since March 2025 Pump.fun graduates tokens to its own AMM, **PumpSwap**
 * (program pAMMBay6…): the graduation transaction runs the pump program's
 * `migrate` instruction, which CPIs into PumpSwap `create_pool`. Before that,
 * graduations created a Raydium AMM v4 pool. The migration authority account
 * (39azUYF…) participates in both eras' transactions, so it remains the
 * low-traffic address to watch — but the transaction *shape* changed, and a
 * detector that requires Raydium involvement sees zero events today.
 * `extractMigration` therefore accepts either AMM (PumpSwap first).
 *
 * Primary path: a WebSocket `onLogs` subscription on the migration authority.
 * Fallback path: if the WebSocket drops, an exponential-backoff reconnect
 * kicks in; a slow polling loop over recent authority signatures also runs so
 * migrations that happened during a disconnect are not lost.
 */

// Pump.fun migration authority (participates in every graduation tx)
export const PUMP_MIGRATION_AUTHORITY = new PublicKey(
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
);
// PumpSwap AMM — where graduations create their pool since March 2025
export const PUMPSWAP_AMM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
// Raydium AMM v4 — legacy migration target (pre-PumpSwap), kept for safety
export const RAYDIUM_AMM_V4 = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);
const WSOL = "So11111111111111111111111111111111111111112";

/** Temporary pipeline debugging: SCANNER_DEBUG=1 logs every stage. */
const SCANNER_DEBUG = process.env.SCANNER_DEBUG === "1";

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
  private watchdogTimer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private stopped = false;
  private lastPolledSig: string | undefined;
  /** last time either the WebSocket or the poller produced activity */
  public lastActivityAt = Date.now();
  // ── observability (surfaced on the dashboard health strip) ────────────────
  /** true while an onLogs subscription id is held (realtime path attempted). */
  public hasSubscription = false;
  /** epoch ms of the last completed poll cycle (the reliable HTTP fallback). */
  public lastPollAt: number | null = null;
  /** signatures returned by the last poll cycle. */
  public lastPollCount = 0;
  /** total migrations handed to the handler since start. */
  public totalDetected = 0;
  /** last error hit while polling (rate-limit / unreachable), for diagnostics. */
  public lastPollError: string | null = null;

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
      this.pollRecent()
        .then(() => (this.lastActivityAt = Date.now()))
        .catch((e) => this.onError(e as Error, "poll"));
    }, 30_000);
    // Watchdog: if the WebSocket has been silent for 10 minutes, assume the
    // subscription died quietly and rebuild it (web3.js does not always
    // surface a dead upstream socket as an error).
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt > 10 * 60_000) {
        this.onError(new Error("no scanner activity for 10m — resubscribing"), "watchdog");
        void this.resubscribe();
      }
    }, 60_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.unsubscribe();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
  }

  /** Swap the underlying connection (RPC failover) and resubscribe. */
  async setConnection(conn: Connection): Promise<void> {
    await this.unsubscribe();
    this.conn = conn;
    if (!this.stopped) this.subscribe();
  }

  private async unsubscribe(): Promise<void> {
    if (this.subId !== null) {
      await this.conn.removeOnLogsListener(this.subId).catch(() => {});
      this.subId = null;
    }
    this.hasSubscription = false;
  }

  private async resubscribe(): Promise<void> {
    await this.unsubscribe();
    this.lastActivityAt = Date.now(); // reset so the watchdog doesn't loop
    this.subscribe();
  }

  private subscribe(): void {
    if (this.stopped) return;
    try {
      this.subId = this.conn.onLogs(
        PUMP_MIGRATION_AUTHORITY,
        (logs) => {
          this.lastActivityAt = Date.now();
          if (logs.err) return; // failed tx
          this.processSignature(logs.signature).catch((e) =>
            this.onError(e as Error, "ws-process")
          );
        },
        "confirmed"
      );
      this.hasSubscription = true;
    } catch (e) {
      this.hasSubscription = false;
      this.onError(e as Error, "subscribe");
      setTimeout(() => this.subscribe(), 5_000);
    }
  }

  /** Catch-up poll over the migration authority's recent signatures. This is
   *  the reliable HTTP fallback — it works even where the realtime websocket
   *  (onLogs) is unavailable, e.g. the public mainnet RPC, which rejects
   *  subscriptions with a 403. `lastPollAt` proves the scanner loop is live. */
  private async pollRecent(): Promise<void> {
    try {
      // Transient RPC failures (timeouts, 429s) are retried with backoff so a
      // single hiccup never surfaces as a failed scan cycle — only an endpoint
      // that stays down after retries reaches the error path / failover logic.
      const sigs = await withRpcRetry(
        () =>
          this.conn.getSignaturesForAddress(
            PUMP_MIGRATION_AUTHORITY,
            { limit: 25, until: this.lastPolledSig },
            "confirmed"
          ),
        { retries: 2, baseDelayMs: 750 }
      );
      this.lastPollAt = Date.now();
      this.lastPollCount = sigs.length;
      this.lastPollError = null;
      if (SCANNER_DEBUG) {
        console.log(
          `[scanner-debug] poll: ${sigs.length} new authority signature(s), cursor=${
            this.lastPolledSig ?? "(none)"} → ${sigs[0]?.signature ?? "(unchanged)"}`
        );
      }
      if (sigs.length > 0) this.lastPolledSig = sigs[0].signature;
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        await this.processSignature(s.signature);
      }
    } catch (e) {
      // Record the reason (rate limit / unreachable) so the dashboard and logs
      // explain an empty token list instead of failing silently.
      this.lastPollError = (e as Error).message;
      throw e;
    }
  }

  /** One-shot connectivity probe for the boot diagnostic: confirms the RPC can
   *  reach the migration authority over HTTP (the polling path). Returns the
   *  number of recent signatures, or throws the underlying RPC error. */
  async probe(): Promise<number> {
    const sigs = await this.conn.getSignaturesForAddress(
      PUMP_MIGRATION_AUTHORITY,
      { limit: 5 },
      "confirmed"
    );
    return sigs.length;
  }

  private async processSignature(signature: string): Promise<void> {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > 5000) {
      // bound memory: drop oldest half
      const keep = [...this.seen].slice(-2500);
      this.seen = new Set(keep);
    }

    const tx = await withRpcRetry(
      () =>
        this.conn.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        }),
      { retries: 2, baseDelayMs: 500 }
    );
    if (!tx) {
      if (SCANNER_DEBUG) console.log(`[scanner-debug] ${signature}: tx not fetchable yet`);
      return;
    }

    const event = extractMigration(tx, signature);
    if (!event) {
      if (SCANNER_DEBUG) {
        console.log(
          `[scanner-debug] ${signature}: not a migration (no PumpSwap/Raydium instruction, or no non-WSOL mint)`
        );
      }
      return;
    }
    if (this.seen.has(`mint:${event.mint}`)) {
      if (SCANNER_DEBUG) console.log(`[scanner-debug] ${signature}: mint ${event.mint} already seen`);
      return;
    }
    this.seen.add(`mint:${event.mint}`);

    if (SCANNER_DEBUG) console.log(`[scanner-debug] ${signature}: MIGRATION → mint ${event.mint}, pool ${event.poolAddress ?? "?"}`);
    await this.handler(event);
    this.totalDetected++;
  }
}

/** All instructions of a parsed tx (top-level + inner CPIs) for a program. */
function instructionsFor(tx: ParsedTransactionWithMeta, program: PublicKey) {
  const top = tx.transaction.message.instructions.filter(
    (ix) => "programId" in ix && ix.programId.equals(program)
  );
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) =>
    i.instructions.filter((ix) => "programId" in ix && ix.programId.equals(program))
  );
  return [...top, ...inner];
}

/**
 * Pull the graduated mint + pool out of a parsed migration tx.
 *
 * PumpSwap era (current): the pump program's `migrate` CPIs into PumpSwap
 * `create_pool` (accounts: pool, global_config, creator, base_mint, …), so
 * the pool is the create_pool instruction's first account.
 * Raydium era (legacy): `initialize2` with the pool at account index 4.
 *
 * Mint: the pool pairs (new token, WSOL). Post token balances can also list
 * the pool's LP mint, so among non-WSOL mints we prefer the one with the
 * Pump.fun vanity suffix ("…pump") that every bonding-curve mint carries.
 */
export function extractMigration(
  tx: ParsedTransactionWithMeta,
  signature: string
): MigrationEvent | null {
  const pumpswapIxs = instructionsFor(tx, PUMPSWAP_AMM);
  const raydiumIxs = instructionsFor(tx, RAYDIUM_AMM_V4);
  if (pumpswapIxs.length === 0 && raydiumIxs.length === 0) return null;

  const mints = [
    ...new Set((tx.meta?.postTokenBalances ?? []).map((b) => b.mint).filter((m) => m !== WSOL)),
  ];
  const mint = mints.find((m) => m.endsWith("pump")) ?? mints[0];
  if (!mint) return null;

  let poolAddress: string | null = null;
  const psIx = pumpswapIxs[0];
  const rayIx = raydiumIxs[0];
  if (psIx && "accounts" in psIx && psIx.accounts.length > 0) {
    poolAddress = psIx.accounts[0].toBase58();
  } else if (rayIx && "accounts" in rayIx && rayIx.accounts.length > 4) {
    poolAddress = rayIx.accounts[4].toBase58();
  }

  return {
    mint,
    poolAddress,
    signature,
    migratedAt: new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000),
  };
}
