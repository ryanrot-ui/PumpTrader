import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { subscribe, CHANNELS } from "@/lib/redis";
import { ENGINE_STATE_ID, updateEngineState } from "@/lib/engineState";
import { decryptSecret } from "@/lib/crypto";
import { validateEnv, rpcEndpoints } from "@/lib/env";
import {
  collectMetrics,
  forgetToken,
  getPairSnapshot,
  getPoolLiquidityUsd,
  getSolPriceUsd,
  getTokenPriceUsd,
} from "./analysis/collectors";
import { scoreToken, DEFAULT_WEIGHTS } from "./analysis/scoring";
import type { ScoreResult, TokenMetrics } from "./analysis/types";
import { MigrationScanner, type MigrationEvent } from "./scanner/migrationScanner";
import { RpcHealthTracker } from "./rpc/health";
import { generateStrategyReport } from "./learning/reporter";
import { dbResilience, isTransientDbError } from "./db/resilience";
import { evaluateBuyRules } from "./trading/rules";
import { checkRisk } from "./trading/riskManager";
import { evaluateExit } from "./trading/exitRules";
import { trackExcursions } from "./trading/excursions";
import { NarrativeEngine, entrySignalsPayload } from "./narrative";
import { evaluateNarrativeExit } from "./narrative/exit";
import { DEFAULT_NARRATIVE_WEIGHTS } from "./narrative/types";
import type { NarrativeReport } from "./narrative/types";
import {
  LiveExecutor,
  PaperExecutor,
  SwapUncertainError,
  getWalletSolBalance,
  getWalletTokenBalance,
  type Executor,
  type SwapResult,
} from "./trading/executor";
import { AsyncLock, withRetries } from "./utils/concurrency";
import { LiveConfig } from "./config";
import { logger } from "./logging/logger";
import { notify } from "./notify";

/**
 * Trading engine worker — run separately from the web app:
 *   npm run engine        (mode from settings; paper by default)
 *
 * Lifecycle:
 *   scanner detects migration → token joins the watchlist → evaluated every
 *   scannerIntervalSec until WATCH_WINDOW expires → if score + rules + risk
 *   all pass, a position is *reserved* under a lock (DB-unique openKey makes
 *   duplicate buys impossible), then the swap executes → the position is
 *   monitored every MONITOR_INTERVAL until an exit rule fires.
 *
 * Reliability:
 *   - RPC failover across SOLANA_RPC_URL + SOLANA_RPC_URLS with a health probe
 *   - scanner WebSocket watchdog + polling fallback
 *   - crash recovery: watchlist & open positions rebuilt from Postgres on boot
 *   - swap retries only when the previous attempt provably did NOT land
 *   - live-mode wallet desync recovery before every sell
 *   - nightly archival of old scanner data
 */

const MONITOR_INTERVAL_MS = 5_000;
const HEALTH_INTERVAL_MS = 10_000;
const ARCHIVE_INTERVAL_MS = 6 * 60 * 60_000;
const WATCH_WINDOW_MS = 45 * 60_000; // stop evaluating tokens older than this
const MIN_AGE_BEFORE_BUY_S = 90; // let post-migration chaos settle first
const ARCHIVE_AFTER_DAYS = parseInt(process.env.ARCHIVE_AFTER_DAYS ?? "14", 10);
const RPC_FAIL_THRESHOLD = 3; // consecutive health-probe failures → failover

// Set by the console.error interceptor (bottom of file) whenever @solana/web3.js
// reports a websocket failure. Read by publishHealth() to derive wsConnected:
// on the public RPC the migration-authority subscription is rejected (403) and
// this keeps updating, so wsConnected stays false and the dashboard shows why
// realtime detection isn't working.
let lastWsErrorAt = 0;

/** The public mainnet endpoint: reachable over HTTP but rejects the websocket
 *  subscriptions the realtime scanner needs, and rate-limits polling. */
function isPublicRpc(url: string | undefined): boolean {
  return !!url && /api\.mainnet-beta\.solana\.com/.test(url);
}

interface WatchedToken {
  tokenId: string;
  mint: string;
  migratedAt: Date;
  detectedAt: Date;
  evaluating: boolean;
}

class TradingEngine {
  private rpcUrls = rpcEndpoints();
  private rpcIndex = 0;
  private rpcFailures = 0;
  private rpcHealth = new RpcHealthTracker(rpcEndpoints());
  private conn = this.makeConnection();

  private config = new LiveConfig();
  private narrative = new NarrativeEngine(
    () => this.config.get().narrativeWeights ?? DEFAULT_NARRATIVE_WEIGHTS
  );
  private lastNarrativeCheck = new Map<string, number>(); // positionId → ts
  private scanner: MigrationScanner;
  private unsubscribeControl: (() => void) | null = null;
  private readOnly = false;
  private watchlist = new Map<string, WatchedToken>();
  private buyLock = new AsyncLock(); // serializes risk-check + reservation
  private selling = new Set<string>();
  private rejectedOnce = new Set<string>(); // daily-stats dedupe
  private scanTimestamps: number[] = []; // for scans/min health metric
  private emergencyStopped = false;
  private timers: NodeJS.Timeout[] = [];
  private evalTimer: NodeJS.Timeout | null = null;
  private lastTradeAt: number | null = null;

  constructor() {
    this.scanner = new MigrationScanner(
      this.conn,
      (e) => this.onMigration(e),
      (err, ctx) => {
        logger.error("scanner", `${ctx}: ${err.message}`);
        // Scanner RPC trouble (poll timeouts survive their own retries before
        // landing here) counts against the endpoint's health, and repeated
        // failures trigger the same failover as the health probe.
        this.rpcHealth.recordFailure(this.rpcUrls[this.rpcIndex], err);
        if (
          this.rpcHealth.consecutiveFailures(this.rpcUrls[this.rpcIndex]) >= RPC_FAIL_THRESHOLD &&
          this.rpcUrls.length > 1
        ) {
          void this.rotateRpc(`scanner ${ctx}: ${err.message}`);
        }
      }
    );
  }

  private makeConnection(): Connection {
    const url = this.rpcUrls[this.rpcIndex];
    return new Connection(url, {
      wsEndpoint: this.rpcIndex === 0 ? process.env.SOLANA_WS_URL : undefined,
      commitment: "confirmed",
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("engine", `starting trading engine (rpc: ${this.rpcUrls[0]}, ${this.rpcUrls.length} endpoint(s))`);
    // Detections queued during a database outage re-enter the watchlist as
    // soon as the flush lands them, so nothing detected offline is lost.
    dbResilience.onDetectionFlushed = (tokenId, d) => {
      if (!this.watchlist.has(d.mint)) {
        this.watchlist.set(d.mint, {
          tokenId,
          mint: d.mint,
          migratedAt: d.migratedAt,
          detectedAt: new Date(),
          evaluating: false,
        });
      }
    };
    // If the initial crash recovery below couldn't run because the database
    // was down at boot, run it as soon as the circuit closes again.
    dbResilience.onReconnected = () => {
      if (!this.bootRecoveryDone) {
        void this.recoverStateFromDb().catch((e) =>
          logger.warn("engine", `deferred crash recovery failed: ${(e as Error).message}`)
        );
      }
    };
    await this.config.start();

    // Crash recovery: resume open positions and recent unresolved tokens.
    // A database that is down AT BOOT must not crash-loop the worker: mark
    // the circuit open, start scanning anyway (detections queue in memory),
    // and recover the moment the database answers a probe.
    try {
      await this.recoverStateFromDb();
    } catch (e) {
      if (!isTransientDbError(e)) throw e;
      dbResilience.recordFailure(e);
      logger.warn(
        "engine",
        "database unreachable at startup — scanning starts anyway; watchlist & positions will be recovered when it comes back"
      );
    }

    await this.scanner.start();
    // Loud, one-time self-test so an empty token list always has a logged
    // reason (RPC unreachable? public endpoint? rate-limited?) rather than
    // failing silently.
    void this.runScannerDiagnostic();
    // Control fast path via Redis pub/sub when configured; the state tick
    // below polls the DB control queue either way, so Redis is optional.
    this.unsubscribeControl = subscribe(CHANNELS.control, (msg) => void this.onControl(msg));

    this.scheduleEvalLoop();
    this.timers.push(setInterval(() => void this.monitorPositions(), MONITOR_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.publishHealth(), HEALTH_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.archiveOldData(), ARCHIVE_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.stateTick(), 5_000));
    await this.stateTick();
    logger.info("engine", "engine running — scanning for Pump.fun migrations");
  }

  /**
   * Rebuild in-memory state from Postgres (idempotent — safe to re-run after
   * an outage): open-position count for the log line, and every recent
   * unresolved token back onto the watchlist.
   */
  private bootRecoveryDone = false;
  private async recoverStateFromDb(): Promise<void> {
    const openPositions = await prisma.position.count({ where: { status: "OPEN" } });
    const recent = await prisma.detectedToken.findMany({
      where: {
        detectedAt: { gte: new Date(Date.now() - WATCH_WINDOW_MS) },
        // Resume anything not already resolved. NOTE: SQL `NOT IN` excludes
        // NULLs, so a token detected-but-not-yet-evaluated before a crash
        // (verdict null) must be matched explicitly or it would be lost.
        OR: [{ verdict: null }, { verdict: { notIn: ["BOUGHT", "IGNORED"] } }],
      },
    });
    for (const t of recent) {
      if (this.watchlist.has(t.mint)) continue; // don't clobber an in-flight evaluation
      this.watchlist.set(t.mint, {
        tokenId: t.id,
        mint: t.mint,
        migratedAt: t.migratedAt,
        detectedAt: t.detectedAt,
        evaluating: false,
      });
    }
    this.bootRecoveryDone = true;
    logger.info("engine", `recovered ${openPositions} open position(s), ${recent.length} watched token(s)`);
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    if (this.evalTimer) clearTimeout(this.evalTimer);
    await this.scanner.stop();
    await this.config.stop();
    this.unsubscribeControl?.();
    await updateEngineState({ status: "stopped" }).catch(() => {});
    logger.info("engine", "engine stopped");
  }

  /**
   * Heartbeat + control poll, every 5s. Writes liveness to the shared
   * EngineState row and consumes any queued control command (the DB queue is
   * the Redis-free fallback for emergency stop / resume) and the read-only
   * flag. Failures are swallowed — the next tick retries.
   */
  private async stateTick(): Promise<void> {
    // While the database circuit is open, this 5s tick doubles as the probe:
    // wait out the backoff, then attempt one cheap query. The first success
    // closes the circuit and flushes everything queued offline.
    if (!dbResilience.healthy && !dbResilience.probeDue()) return;
    try {
      const state = await prisma.engineState.upsert({
        where: { id: ENGINE_STATE_ID },
        update: {
          heartbeatAt: new Date(),
          status: this.emergencyStopped ? "emergency_stopped" : "running",
        },
        create: { id: ENGINE_STATE_ID, heartbeatAt: new Date(), status: "running" },
      });
      await dbResilience.recordSuccess();
      this.readOnly = state.readOnly;
      if (state.controlRequest) {
        await prisma.engineState.update({
          where: { id: ENGINE_STATE_ID },
          data: { controlRequest: null, controlRequestedAt: null },
        });
        await this.onControl(state.controlRequest);
      }
    } catch (e) {
      if (isTransientDbError(e)) {
        dbResilience.recordFailure(e); // one structured status line, throttled
      } else {
        logger.warn("engine", `state tick failed: ${(e as Error).message}`);
      }
    }
  }

  /** Self-scheduling evaluation loop so scannerIntervalSec hot-reloads. */
  private scheduleEvalLoop(): void {
    const intervalMs = this.config.get().scannerIntervalSec * 1000;
    this.evalTimer = setTimeout(async () => {
      try {
        await this.evaluateWatchlist();
      } catch (e) {
        logger.exception("engine", "evaluation loop failed", e);
      }
      this.scheduleEvalLoop();
    }, intervalMs);
  }

  private async onControl(msg: string): Promise<void> {
    if (msg === "emergency_stop" && !this.emergencyStopped) {
      this.emergencyStopped = true;
      await updateEngineState({
        status: "emergency_stopped",
        controlRequest: null,
        controlRequestedAt: null,
      }).catch(() => {});
      logger.warn("engine", "EMERGENCY STOP received — no new buys; exiting all positions");
      void this.emergencyExitAll();
    } else if (msg === "resume" && this.emergencyStopped) {
      this.emergencyStopped = false;
      await updateEngineState({
        status: "running",
        controlRequest: null,
        controlRequestedAt: null,
      }).catch(() => {});
      logger.info("engine", "resumed from emergency stop");
    }
  }

  // ── RPC health & failover ─────────────────────────────────────────────────

  private async publishHealth(): Promise<void> {
    // Health is written to the database — skip while the circuit is open
    // (the RPC probe/rotation still matters, so only the write is gated).
    const dbUp = dbResilience.healthy;
    let rpcLatencyMs: number | null = null;
    const t0 = Date.now();
    try {
      await this.conn.getSlot("confirmed");
      rpcLatencyMs = Date.now() - t0;
      this.rpcFailures = 0;
      this.rpcHealth.recordSuccess(this.rpcUrls[this.rpcIndex], rpcLatencyMs);
    } catch (probeErr) {
      this.rpcFailures++;
      this.rpcHealth.recordFailure(this.rpcUrls[this.rpcIndex], probeErr);
      logger.warn("engine", `RPC health probe failed (${this.rpcFailures}/${RPC_FAIL_THRESHOLD})`);
      if (this.rpcFailures >= RPC_FAIL_THRESHOLD && this.rpcUrls.length > 1) {
        await this.rotateRpc(`health probe failed ${this.rpcFailures}×`);
      }
    }

    const cutoff = Date.now() - 60_000;
    this.scanTimestamps = this.scanTimestamps.filter((t) => t > cutoff);
    if (!dbUp) return; // RPC probe done; the DB write waits for recovery
    const mem = process.memoryUsage();
    const rpcUrl = this.rpcUrls[this.rpcIndex];
    const tokensDetected = await prisma.detectedToken.count().catch(() => undefined);
    // No ws error in the last 90s → treat the realtime subscription as healthy.
    // On the public RPC the 403 recurs, so this stays false and the dashboard
    // shows the scanner is running on the polling path only.
    const wsConnected = lastWsErrorAt === 0 ? this.scanner.hasSubscription : Date.now() - lastWsErrorAt > 90_000;

    await updateEngineState({
      health: {
        rpcUrl,
        rpcLatencyMs,
        rpcFailures: this.rpcFailures,
        scannerLastEventAt: this.scanner.lastActivityAt,
        scansPerMin: this.scanTimestamps.length,
        watchlistSize: this.watchlist.size,
        lastTradeAt: this.lastTradeAt,
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapMb: Math.round(mem.heapUsed / 1024 / 1024),
        scannerSubscribed: this.scanner.hasSubscription,
        lastScanAt: this.scanner.lastPollAt,
        lastPollCount: this.scanner.lastPollCount,
        wsConnected,
        usingPublicRpc: isPublicRpc(rpcUrl),
        tokensDetected,
        scannerError: this.scanner.lastPollError,
        settingsLoadedAt: this.config.loadedSettingsUpdatedAtMs,
        ...this.rpcHealth.snapshot(rpcUrl),
        ...dbResilience.snapshot(),
      },
    }).catch(() => {});

    // Keep an explanation in the logs while the list is empty.
    void this.logIfNoDetections();
  }

  private lastFailoverAt = 0;
  private async rotateRpc(reason = "unspecified"): Promise<void> {
    // Debounce: the probe and the scanner can both hit the threshold in the
    // same window; one failover per 30s is enough.
    if (Date.now() - this.lastFailoverAt < 30_000) return;
    this.lastFailoverAt = Date.now();
    const from = this.rpcUrls[this.rpcIndex];
    // Health-scored failover: switch to the healthiest alternative, not just
    // the next in line — a flapping endpoint isn't re-chosen while a better
    // one exists.
    const to = this.rpcHealth.bestAlternative(from);
    if (!to) return;
    this.rpcIndex = Math.max(0, this.rpcUrls.indexOf(to));
    this.rpcFailures = 0;
    this.rpcHealth.recordFailover(from, to, reason);
    this.conn = this.makeConnection();
    this.liveExecutor = null; // rebuild against the new connection on demand
    await this.scanner.setConnection(this.conn);
    logger.warn("engine", `RPC failover → ${to} (${reason})`);
    void notify("error", "RPC failover", `Switched to ${to}\nReason: ${reason}`);
  }

  // ── scanning & evaluation ─────────────────────────────────────────────────

  /**
   * One-time boot self-test for the scanner. Confirms the RPC can reach the
   * Pump.fun migration authority over HTTP (the polling path), and warns loudly
   * when running on the public endpoint, whose websocket the realtime scanner
   * cannot use. Every outcome is logged so an empty token list is explainable.
   */
  private async runScannerDiagnostic(): Promise<void> {
    const rpcUrl = this.rpcUrls[this.rpcIndex];
    const usingPublic = isPublicRpc(rpcUrl);
    try {
      const count = await this.scanner.probe();
      logger.info(
        "scanner",
        `scanner online — polling path reachable (RPC ${rpcUrl} returned ${count} recent migration-authority signatures). ` +
          `New Pump.fun graduations (PumpSwap pool creations) will appear here as they happen.`
      );
    } catch (e) {
      logger.error(
        "scanner",
        `scanner cannot reach the migration authority over RPC (${rpcUrl}): ${(e as Error).message}. ` +
          `No tokens will be detected until the RPC is reachable — check SOLANA_RPC_URL / rate limits.`
      );
    }
    if (usingPublic) {
      logger.warn(
        "scanner",
        "Using the PUBLIC Solana RPC (api.mainnet-beta.solana.com). It rejects the realtime " +
          "websocket subscription the scanner uses (HTTP 403) and rate-limits polling, so token " +
          "detection will be slow or empty. Set SOLANA_RPC_URL (and SOLANA_WS_URL) to a dedicated " +
          "provider — e.g. a free Helius key — on BOTH the web and engine services for reliable scanning."
      );
    }
  }

  /** Throttled reminder that explains a persistently empty token list. */
  private lastEmptyReasonLogAt = 0;
  private async logIfNoDetections(): Promise<void> {
    if (this.scanner.totalDetected > 0) return;
    if (Date.now() - this.lastEmptyReasonLogAt < 10 * 60_000) return;
    this.lastEmptyReasonLogAt = Date.now();
    const rpcUrl = this.rpcUrls[this.rpcIndex];
    const polledOk = this.scanner.lastPollAt != null && this.scanner.lastPollError == null;
    if (!polledOk) {
      logger.warn(
        "scanner",
        `No tokens detected yet. Scanner poll is failing: ${this.scanner.lastPollError ?? "no poll completed"} ` +
          `(RPC ${rpcUrl}). ${isPublicRpc(rpcUrl) ? "Set a dedicated SOLANA_RPC_URL." : "Check RPC reachability/limits."}`
      );
    } else {
      logger.info(
        "scanner",
        `No migrations detected yet, but the scanner is active (last poll returned ${this.scanner.lastPollCount} ` +
          `authority signatures). This is normal during quiet periods; a new coin appears here when one migrates.` +
          (isPublicRpc(rpcUrl) ? " Detection is degraded on the public RPC — set SOLANA_RPC_URL for realtime scanning." : "")
      );
    }
  }

  private async onMigration(e: MigrationEvent): Promise<void> {
    if (this.watchlist.has(e.mint)) return;
    // Database offline → queue the detection (deduped by mint) and keep
    // scanning; the flush re-enters it into the watchlist on recovery.
    if (!dbResilience.healthy) {
      dbResilience.enqueueDetection({ mint: e.mint, poolAddress: e.poolAddress, migratedAt: e.migratedAt });
      return;
    }
    try {
      const existing = await prisma.detectedToken.findUnique({ where: { mint: e.mint } });
      // The websocket and polling paths can race on the same brand-new mint;
      // the unique(mint) constraint makes the second insert fail (P2002), so
      // fall back to reading the row the winner created.
      const token =
        existing ??
        (await prisma.detectedToken
          .create({
            data: {
              mint: e.mint,
              poolAddress: e.poolAddress,
              migratedAt: e.migratedAt,
              verdict: null,
            },
          })
          .catch(async (err) => {
            if ((err as { code?: string }).code === "P2002") {
              const row = await prisma.detectedToken.findUnique({ where: { mint: e.mint } });
              if (row) return row;
            }
            throw err;
          }));
      this.watchlist.set(e.mint, {
        tokenId: token.id,
        mint: e.mint,
        migratedAt: e.migratedAt,
        detectedAt: token.detectedAt,
        evaluating: false,
      });
      await this.bumpDaily({ scanned: 1 });
      const detectionDelayMs = Date.now() - e.migratedAt.getTime();
      const meta: Record<string, unknown> = {
        pool: e.poolAddress,
        signature: e.signature,
        detectionDelayMs,
      };
      if (process.env.SCANNER_DEBUG === "1") {
        meta.totalTokenRows = await prisma.detectedToken.count().catch(() => undefined);
      }
      logger.info(
        "scanner",
        `migration detected: ${e.mint} (${(detectionDelayMs / 1000).toFixed(1)}s after migration)${existing ? " (already in DB, re-watching)" : ""}`,
        meta
      );
    } catch (err) {
      // The database dropped mid-insert: open the circuit and queue the
      // detection instead of surfacing a per-token Prisma error.
      if (isTransientDbError(err)) {
        dbResilience.recordFailure(err);
        dbResilience.enqueueDetection({ mint: e.mint, poolAddress: e.poolAddress, migratedAt: e.migratedAt });
        return;
      }
      throw err;
    }
  }

  /** Read-only mode: scan and score, but never execute anything.
   *  The flag lives in EngineState and is refreshed by the 5s state tick. */
  private isReadOnly(): boolean {
    return this.readOnly;
  }

  private async evaluateWatchlist(): Promise<void> {
    const settings = this.config.get();
    if (!settings.botEnabled || this.emergencyStopped) return;

    // Evaluate tokens concurrently but bounded (protects RPC + APIs)
    const tokens = [...this.watchlist.values()].filter((t) => !t.evaluating);
    const BATCH = 8;
    for (let i = 0; i < tokens.length; i += BATCH) {
      await Promise.allSettled(tokens.slice(i, i + BATCH).map((t) => this.evaluateToken(t)));
    }
  }

  private async evaluateToken(t: WatchedToken): Promise<void> {
    t.evaluating = true;
    this.scanTimestamps.push(Date.now());
    try {
      const age = Date.now() - t.migratedAt.getTime();
      if (age > WATCH_WINDOW_MS) {
        // The expiry verdict needs a DB write; while offline, keep the token
        // watched — it will be expired properly once the database is back.
        if (!dbResilience.healthy) return;
        this.watchlist.delete(t.mint);
        forgetToken(t.mint);
        this.narrative.forget(t.mint);
        await prisma.detectedToken.update({
          where: { id: t.tokenId },
          data: {
            verdict: "IGNORED",
            rejectionReasons: [
              "watch window (45 min) expired without a buy decision — the last full evaluation is preserved in the decision trace",
            ],
          },
        });
        return;
      }

      const settings = this.config.get();
      const evalStartedAt = Date.now();
      const metrics = await collectMetrics(this.conn, t.mint, t.migratedAt);
      const weights = settings.scoringWeights ?? DEFAULT_WEIGHTS;
      const score = scoreToken(metrics, weights);
      const scoredMs = Date.now() - evalStartedAt;

      // Sanitize numerics before persisting: a NaN/Infinity from upstream
      // arithmetic (e.g. a division on partial API data) must become null,
      // not an Invalid-invocation crash for the whole evaluation.
      const fin = (v: number | null): number | null =>
        v !== null && Number.isFinite(v) ? v : null;
      const safeTotal = Number.isFinite(score.total)
        ? Math.round(Math.max(0, Math.min(100, score.total)))
        : 0;

      // Database offline (circuit open): don't attempt any Prisma call —
      // queue this evaluation's history (with its real timestamp) and move
      // on. Verdicts/trades are deliberately NOT queued: verdicts are
      // recomputed fresh next cycle, and stale trade decisions must never
      // execute after the outage.
      if (!dbResilience.healthy) {
        dbResilience.enqueueScore({
          tokenId: t.tokenId,
          mint: t.mint,
          at: new Date(),
          score: {
            total: safeTotal,
            breakdown: JSON.parse(JSON.stringify(score.metrics)),
            greenFlags: score.greenFlags.map((f) => f.label),
            redFlags: score.redFlags.map((f) => f.label),
            critical: score.criticalFlags.length > 0,
          },
          snapshot: {
            priceUsd: fin(metrics.priceUsd),
            liquiditySol: fin(metrics.liquiditySol),
            marketCapUsd: fin(metrics.marketCapUsd),
            volume5mUsd: fin(metrics.volume5mUsd),
            holderCount: metrics.holderCount,
            txPerMinute: fin(metrics.txPerMinute),
            buySellRatio: fin(metrics.buySellRatio),
          },
        });
        return;
      }

      await prisma.$transaction([
        prisma.scoreRecord.create({
          data: {
            tokenId: t.tokenId,
            total: safeTotal,
            breakdown: JSON.parse(JSON.stringify(score.metrics)),
            greenFlags: score.greenFlags.map((f) => f.label),
            redFlags: score.redFlags.map((f) => f.label),
            critical: score.criticalFlags.length > 0,
          },
        }),
        prisma.tokenSnapshot.create({
          data: {
            tokenId: t.tokenId,
            priceUsd: fin(metrics.priceUsd),
            liquiditySol: fin(metrics.liquiditySol),
            marketCapUsd: fin(metrics.marketCapUsd),
            volume5mUsd: fin(metrics.volume5mUsd),
            holderCount: metrics.holderCount,
            txPerMinute: fin(metrics.txPerMinute),
            buySellRatio: fin(metrics.buySellRatio),
          },
        }),
        prisma.detectedToken.update({
          where: { id: t.tokenId },
          data: {
            score: safeTotal,
            symbol: metrics.symbol ?? undefined,
            name: metrics.name ?? undefined,
            imageUrl: metrics.imageUrl ?? undefined,
            websiteUrl: metrics.websiteUrl ?? undefined,
            twitterUrl: metrics.twitterUrl ?? undefined,
            telegramUrl: metrics.telegramUrl ?? undefined,
          },
        }),
      ]);

      if (score.total >= 90) {
        void notify("high_score_token", `High score: ${t.mint.slice(0, 8)}…`, score.explanation);
      }

      if (metrics.ageSinceMigrationSec < MIN_AGE_BEFORE_BUY_S) return; // let it settle

      // Narrative & social research (cached; degrades to neutral scores when
      // sources are unavailable). Runs for every watched token so the
      // scanner UI always shows the intelligence alongside the tech score.
      let narrativeReport: NarrativeReport | null = null;
      try {
        narrativeReport = await this.narrative.evaluate(t.tokenId, metrics);
      } catch (e) {
        logger.warn("scoring", `narrative evaluation failed for ${t.mint.slice(0, 8)}…: ${(e as Error).message}`);
      }

      const decision = evaluateBuyRules(metrics, score, settings, narrativeReport);
      // Full rule-by-rule trace + data confidence persisted on every
      // evaluation, so the dashboard can always explain the decision.
      const decisionData = {
        decisionTrace: JSON.parse(JSON.stringify(decision.trace)),
        confidence: decision.confidence,
      };
      if (!decision.buy) {
        // No market data at all (pool not indexed on DexScreener yet) means
        // the rejection would be an artifact of missing inputs, not a verdict
        // on the token. Keep it EVALUATING — the next cycle retries, and the
        // watch-window expiry still guarantees a terminal state.
        if (metrics.priceUsd == null && metrics.liquidityUsd == null) {
          logger.debug("scoring", `no market data yet for ${t.mint.slice(0, 8)}… — still evaluating`);
          return;
        }
        // Three-layer decision: only safety-gate failures reject (IGNORE);
        // a safe token below the score threshold stays WATCHed and is
        // re-evaluated every cycle until the window expires.
        const verdict = decision.action === "watch" ? "WATCH" : "REJECTED";
        await prisma.detectedToken.update({
          where: { id: t.tokenId },
          data: { verdict, rejectionReasons: decision.reasons, ...decisionData },
        });
        if (verdict === "REJECTED" && !this.rejectedOnce.has(t.mint)) {
          this.rejectedOnce.add(t.mint);
          await this.bumpDaily({ rejected: 1 });
          if (this.rejectedOnce.size > 10_000) this.rejectedOnce.clear();
        }
        logger.debug("scoring", `${verdict.toLowerCase()} ${t.mint.slice(0, 8)}… (${score.total})`, {
          reasons: decision.reasons,
        });
        return;
      }

      await prisma.detectedToken.update({
        where: { id: t.tokenId },
        data: { verdict: "BUY_CANDIDATE", rejectionReasons: [], ...decisionData },
      });
      if (this.isReadOnly()) {
        logger.info("risk", `read-only mode: would have bought ${t.mint.slice(0, 8)}… (score ${score.total})`);
        return;
      }
      await this.tryBuy(t, metrics, score, decision.reasons, narrativeReport, scoredMs);
    } catch (e) {
      const err = e as Error & { code?: string; meta?: unknown };
      // Database dropped mid-write: open the circuit (one structured status
      // line, throttled) — subsequent evaluations queue instead of failing.
      if (isTransientDbError(err)) {
        dbResilience.recordFailure(err);
        return;
      }
      // The token row vanished mid-evaluation (P2025 record-not-found /
      // P2003 broken relation): stop evaluating a ghost instead of failing
      // every cycle. Other tokens are unaffected either way — evaluations
      // run isolated per token.
      if (err.code === "P2025" || err.code === "P2003") {
        this.watchlist.delete(t.mint);
        forgetToken(t.mint);
        logger.warn(
          "scoring",
          `token row for ${t.mint} disappeared mid-evaluation (${err.code}) — dropped from watchlist`
        );
        return;
      }
      // Complete diagnostics, never a truncated mystery: full message,
      // Prisma error code + meta, the token, and the operation context.
      logger.exception("scoring", `evaluate ${t.mint} failed`, e, {
        mint: t.mint,
        tokenId: t.tokenId,
        prismaCode: err.code ?? null,
        prismaMeta: err.meta ? JSON.parse(JSON.stringify(err.meta)) : null,
        operation: "score/persist/decide cycle (scoreRecord.create + tokenSnapshot.create + detectedToken.update)",
      });
    } finally {
      t.evaluating = false;
    }
  }

  // ── buying ────────────────────────────────────────────────────────────────

  private async tryBuy(
    t: WatchedToken,
    metrics: TokenMetrics,
    score: ScoreResult,
    reasons: string[],
    narrativeReport: NarrativeReport | null,
    scoredMs: number
  ): Promise<void> {
    const settings = this.config.get();
    const priceUsd = metrics.priceUsd;
    const symbol = metrics.symbol;
    const entryReason = `score ${score.total}: ${reasons.join("; ")}`;

    // Entry snapshot for the learning analytics: per-metric scoring values,
    // the market context the trade was taken in, and full timing telemetry.
    // The optimizer correlates all of it against the realized outcome.
    const entrySignals = {
      ...(narrativeReport
        ? entrySignalsPayload(score.total, narrativeReport)
        : { scannerScore: score.total }),
      metrics: Object.fromEntries(score.metrics.map((m) => [m.metric, m.value])),
      context: {
        marketCapUsd: metrics.marketCapUsd,
        liquiditySol: metrics.liquiditySol,
        volume5mUsd: metrics.volume5mUsd,
        buySellRatio: metrics.buySellRatio,
        momentum: metrics.momentum,
        momentumAcceleration: metrics.momentumAcceleration,
        priceChange5mPct: metrics.priceChange5mPct,
        priceChange1hPct: metrics.priceChange1hPct,
        holderCount: metrics.holderCount,
        tokenAgeMin: (Date.now() - t.migratedAt.getTime()) / 60_000,
        detectionToBuyMs: Date.now() - t.detectedAt.getTime(),
      },
      timing: {
        migrationToDetectionMs: t.detectedAt.getTime() - t.migratedAt.getTime(),
        scoredMs,
      },
    };

    // Critical section: risk check + position reservation are serialized so
    // concurrent evaluations can never over-commit exposure, and the
    // DB-unique openKey makes a duplicate open position on this mint
    // impossible even across engine restarts.
    const reservation = await this.buyLock.run(async () => {
      const risk = checkRisk(settings, await this.riskState());
      if (!risk.allowed) {
        logger.info("risk", `buy blocked for ${t.mint.slice(0, 8)}…`, { reasons: risk.reasons });
        return null;
      }

      // Live-mode pre-trade validation: wallet must actually hold enough SOL
      // (trade size + fee/rent headroom).
      if (!settings.paperTrading) {
        const executor = (await this.getExecutor(false)) as LiveExecutor;
        const balance = await getWalletSolBalance(this.conn, executor.publicKey());
        if (balance < risk.sizeSol + 0.01) {
          logger.error("risk", `insufficient wallet balance: ${balance.toFixed(4)} SOL < ${risk.sizeSol} + fees`);
          void notify("wallet_issue", "Insufficient balance", `Bot wallet has ${balance.toFixed(4)} SOL`);
          return null;
        }
      }

      try {
        return await prisma.position.create({
          data: {
            mint: t.mint,
            symbol,
            openKey: t.mint, // unique while OPEN → duplicate-buy guard
            status: "OPEN",
            paper: settings.paperTrading,
            entrySol: risk.sizeSol,
            entryPriceUsd: priceUsd,
            peakPriceUsd: priceUsd,
            tokenQty: 0, // reserved; set after the swap fills
            entryReason,
            scannerScore: score.total,
            scoreExplanation: score.explanation,
            // Signal snapshot at entry — compared with the outcome by the
            // learning analytics (optimizer + strategy reports).
            entrySignals: JSON.parse(JSON.stringify(entrySignals)),
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return null; // position already open for this mint — duplicate guard hit
        }
        throw e;
      }
    });
    if (!reservation) return;

    const started = Date.now();
    try {
      const executor = await this.getExecutor(settings.paperTrading);
      const { result, attempts } = await withRetries<SwapResult>(
        () =>
          executor.buy(t.mint, reservation.entrySol, {
            maxSlippageBps: settings.maxSlippageBps,
            priorityFeeLamports: settings.priorityFeeLamports,
          }),
        {
          retries: settings.retryCount,
          // Only retry when the previous attempt provably did NOT land.
          isRetryable: (err) => !(err instanceof SwapUncertainError),
          onRetry: (err, attempt) =>
            logger.warn("executor", `buy retry ${attempt} for ${t.mint.slice(0, 8)}…: ${(err as Error).message}`),
        }
      );

      const latencyMs = Date.now() - started;
      await prisma.$transaction([
        prisma.position.update({
          where: { id: reservation.id },
          data: { tokenQty: result.outAmount },
        }),
        prisma.trade.create({
          data: {
            tokenId: t.tokenId,
            positionId: reservation.id,
            side: "BUY",
            paper: result.paper,
            mint: t.mint,
            symbol,
            amountSol: reservation.entrySol,
            tokenQty: result.outAmount,
            priceUsd,
            slippageBps: settings.maxSlippageBps,
            signature: result.signature,
            reason: entryReason,
            latencyMs,
            rpcUrl: this.rpcUrls[this.rpcIndex],
            priorityFeeLamports: settings.priorityFeeLamports,
            retries: attempts - 1,
          },
        }),
        prisma.detectedToken.update({
          where: { id: t.tokenId },
          data: { verdict: "BOUGHT" },
        }),
      ]);
      await this.bumpDaily({ bought: 1, trades: 1 });
      this.watchlist.delete(t.mint);
      forgetToken(t.mint);
      this.lastTradeAt = Date.now();

      // Entry timing diagnostics: every stage of detection→execution, so a
      // slow entry is attributable to its actual bottleneck.
      const migrationToDetectionMs = t.detectedAt.getTime() - t.migratedAt.getTime();
      const totalDelayMs = Date.now() - t.detectedAt.getTime();
      logger.info(
        "executor",
        `BUY ${t.mint.slice(0, 8)}… ${reservation.entrySol} SOL (${result.paper ? "paper" : "live"}, ${attempts} attempt(s)) — ` +
          `migration detected: ${migrationToDetectionMs}ms | token scored: ${scoredMs}ms | buy executed: ${latencyMs}ms | total detection→fill: ${totalDelayMs}ms`,
        {
          signature: result.signature,
          reason: entryReason,
          timing: { migrationToDetectionMs, scoredMs, buyExecutedMs: latencyMs, totalDelayMs },
        }
      );
      void notify(
        "buy",
        `Bought ${symbol ?? t.mint.slice(0, 8) + "…"} (${result.paper ? "paper" : "LIVE"})`,
        `${reservation.entrySol} SOL @ $${priceUsd?.toPrecision(4) ?? "?"}\n${entryReason}`
      );
    } catch (e) {
      if (e instanceof SwapUncertainError) {
        // The swap MAY have landed. Keep the position open for the monitor's
        // balance reconciliation, flag it loudly, never auto-retry.
        await prisma.trade.create({
          data: {
            tokenId: t.tokenId,
            positionId: reservation.id,
            side: "BUY",
            paper: false,
            mint: t.mint,
            symbol,
            amountSol: reservation.entrySol,
            tokenQty: 0,
            signature: e.signature,
            reason: entryReason,
            error: e.message,
            rpcUrl: this.rpcUrls[this.rpcIndex],
          },
        });
        logger.error("executor", `UNVERIFIED buy for ${t.mint.slice(0, 8)}… — check signature ${e.signature}`);
        void notify("wallet_issue", "Unverified buy — manual check required", `${t.mint}\n${e.signature}`);
        return;
      }
      // Clean failure: roll back the reservation so exposure is released.
      await prisma.position.delete({ where: { id: reservation.id } }).catch(() => {});
      logger.exception("executor", `buy ${t.mint.slice(0, 8)}… failed after retries`, e);
      void notify("error", "Buy failed", `${t.mint}: ${(e as Error).message}`);
    }
  }

  // ── position monitoring ───────────────────────────────────────────────────

  private async monitorPositions(): Promise<void> {
    // Positions can't be read or exited without the database; skip the tick
    // quietly while the circuit is open (the state tick handles recovery).
    if (!dbResilience.healthy) return;
    const positions = await prisma.position.findMany({ where: { status: "OPEN" } }).catch((e) => {
      if (isTransientDbError(e)) {
        dbResilience.recordFailure(e);
        return [] as Awaited<ReturnType<typeof prisma.position.findMany>>;
      }
      throw e;
    });
    if (positions.length === 0) return;
    const settings = this.config.get();

    await Promise.allSettled(
      positions.map(async (p) => {
        if (this.selling.has(p.id)) return;
        // ONE DexScreener call per tick: price + liquidity + 5m momentum.
        const snap = await getPairSnapshot(p.mint);
        const price = snap?.priceUsd ?? null;
        if (!snap || !price || !p.entryPriceUsd) return; // stale/no price → never act on it

        // Track peak / best unrealized gain / deepest drawdown for the
        // trailing stop and the analytics on every trade record.
        const excursions = trackExcursions(p.entryPriceUsd, p, price);
        if (excursions.changed) {
          await prisma.position.update({ where: { id: p.id }, data: excursions.next });
        }
        const peak = excursions.next.peakPriceUsd ?? price;

        // liquidity drop since entry → rug signal (baseline stored on the row)
        let liquidityDropPct: number | null = null;
        const liqNow = snap.liquidityUsd;
        if (liqNow !== null) {
          if (p.entryLiquidityUsd == null) {
            await prisma.position.update({
              where: { id: p.id },
              data: { entryLiquidityUsd: liqNow },
            });
          } else if (p.entryLiquidityUsd > 0) {
            liquidityDropPct = ((liqNow - p.entryLiquidityUsd) / p.entryLiquidityUsd) * 100;
          }
        }

        // 5m-volume baseline at entry → the volume-fade momentum exit
        let entryVolume5mUsd = p.entryVolume5mUsd;
        if (snap.volume5mUsd !== null && entryVolume5mUsd == null) {
          entryVolume5mUsd = snap.volume5mUsd;
          await prisma.position.update({
            where: { id: p.id },
            data: { entryVolume5mUsd },
          });
        }

        const decision = evaluateExit(settings, {
          entryPriceUsd: p.entryPriceUsd,
          currentPriceUsd: price,
          peakPriceUsd: peak,
          openedAt: p.openedAt,
          liquidityDropPct,
          buySellRatio5m:
            snap.buys5m !== null && snap.sells5m !== null
              ? snap.buys5m / Math.max(snap.sells5m, 1)
              : null,
          volume5mUsd: snap.volume5mUsd,
          entryVolume5mUsd,
        });
        if (decision.exit) {
          if (this.isReadOnly()) {
            logger.warn("risk", `read-only mode: exit signal suppressed for ${p.mint.slice(0, 8)}… (${decision.kind})`);
            return;
          }
          await this.closePosition(p.id, price, decision.portionPct, decision.kind!, decision.reason);
          return;
        }

        // Narrative deterioration watch (configurable: off | alert | execute)
        await this.monitorNarrative(p, price);
      })
    );
  }

  /**
   * Re-research an open position's narrative on a slow cadence and act on
   * deterioration per settings.narrativeExitMode: "alert" logs + notifies,
   * "execute" market-exits. Read-only mode always suppresses execution.
   */
  private static readonly NARRATIVE_CHECK_MS = 60_000;

  private async monitorNarrative(
    p: { id: string; mint: string; entrySignals: unknown },
    priceUsd: number
  ): Promise<void> {
    const settings = this.config.get();
    if (settings.narrativeExitMode === "off") return;
    const last = this.lastNarrativeCheck.get(p.id) ?? 0;
    if (Date.now() - last < TradingEngine.NARRATIVE_CHECK_MS) return;
    this.lastNarrativeCheck.set(p.id, Date.now());

    try {
      const token = await prisma.detectedToken.findUnique({ where: { mint: p.mint } });
      if (!token) return;
      const metrics = await collectMetrics(this.conn, p.mint, token.migratedAt);
      const report = await this.narrative.evaluate(token.id, metrics);

      const entry = (p.entrySignals ?? {}) as { narrativeScore?: number };
      const signal = evaluateNarrativeExit({
        entryNarrativeScore: entry.narrativeScore ?? null,
        currentNarrativeScore: report.narrativeScore,
        currentRugRiskScore: report.rugRiskScore,
        sentiment: report.sentiment,
      });
      if (!signal.exit) return;

      if (settings.narrativeExitMode === "alert" || this.isReadOnly()) {
        logger.warn("risk", `narrative deteriorating on ${p.mint.slice(0, 8)}…: ${signal.reason} (alert only)`);
        void notify("rug_warning", "Narrative deteriorating", `${p.mint}\n${signal.reason}`);
        return;
      }
      await this.closePosition(p.id, priceUsd, 100, "narrative_exit", `narrative exit: ${signal.reason}`);
    } catch (e) {
      logger.warn("risk", `narrative monitor failed for ${p.mint.slice(0, 8)}…: ${(e as Error).message}`);
    }
  }

  private async closePosition(
    positionId: string,
    priceUsd: number,
    portionPct: number,
    kind: string,
    reason: string
  ): Promise<void> {
    if (this.selling.has(positionId)) return;
    this.selling.add(positionId);
    const started = Date.now();
    try {
      const p = await prisma.position.findUnique({ where: { id: positionId } });
      if (!p || p.status !== "OPEN") return;

      const settings = this.config.get();
      const executor = await this.getExecutor(p.paper);
      let sellQty = p.tokenQty * (portionPct / 100);

      // Live-mode desync recovery: verify the wallet actually holds what the
      // DB says before selling. If the tokens are gone (manual sale, partial
      // fill, unverified buy that never landed), reconcile instead of firing
      // a swap that will fail or sell someone else's balance.
      if (!p.paper) {
        const live = executor as LiveExecutor;
        const onChain = await getWalletTokenBalance(this.conn, live.publicKey(), p.mint);
        if (onChain <= 0) {
          await prisma.position.update({
            where: { id: p.id },
            data: {
              status: "CLOSED",
              openKey: null,
              exitReason: `reconciled: wallet holds no ${p.mint.slice(0, 8)}… (sold externally or buy never landed)`,
              closedAt: new Date(),
            },
          });
          logger.warn("executor", `position ${p.id} reconciled — no on-chain balance for ${p.mint.slice(0, 8)}…`);
          void notify("wallet_issue", "Position reconciled", `No on-chain balance for ${p.mint}`);
          return;
        }
        if (onChain < sellQty) {
          logger.warn("executor", `wallet desync: selling on-chain balance ${onChain} instead of recorded ${sellQty}`);
          sellQty = onChain;
        }
      }

      const { result, attempts } = await withRetries<SwapResult>(
        () =>
          executor.sell(p.mint, sellQty, {
            maxSlippageBps: settings.maxSlippageBps,
            priorityFeeLamports: settings.priorityFeeLamports,
          }),
        {
          retries: settings.retryCount,
          isRetryable: (err) => !(err instanceof SwapUncertainError),
          onRetry: (err, attempt) =>
            logger.warn("executor", `sell retry ${attempt} for ${p.mint.slice(0, 8)}…: ${(err as Error).message}`),
        }
      );
      const receivedSol = result.outAmount / 1_000_000_000;
      const latencyMs = Date.now() - started;

      const soldAll = portionPct >= 99.999;
      const proportionalEntry = p.entrySol * (portionPct / 100);
      // Realized PnL for THIS sell; accumulated onto the position so partial
      // take-profits are never lost from position-based analytics.
      const pnlSol = receivedSol - proportionalEntry;
      const totalPnlSol = (p.pnlSol ?? 0) + pnlSol;
      const pnlPct = p.entryPriceUsd ? ((priceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100 : null;

      const token = await prisma.detectedToken.findUnique({ where: { mint: p.mint } });
      await prisma.$transaction([
        prisma.trade.create({
          data: {
            tokenId: token?.id ?? null,
            positionId: p.id,
            side: "SELL",
            paper: p.paper,
            mint: p.mint,
            symbol: p.symbol,
            amountSol: receivedSol,
            tokenQty: sellQty,
            priceUsd,
            slippageBps: settings.maxSlippageBps,
            signature: result.signature,
            reason,
            latencyMs,
            rpcUrl: this.rpcUrls[this.rpcIndex],
            priorityFeeLamports: settings.priorityFeeLamports,
            retries: attempts - 1,
          },
        }),
        prisma.position.update({
          where: { id: p.id },
          data: soldAll
            ? {
                status: "CLOSED",
                openKey: null,
                exitSol: receivedSol,
                exitPriceUsd: priceUsd,
                pnlSol: totalPnlSol,
                pnlPct,
                exitReason: reason,
                closedAt: new Date(),
              }
            : {
                tokenQty: p.tokenQty - sellQty,
                entrySol: p.entrySol - proportionalEntry,
                pnlSol: totalPnlSol, // realized so far from partial sells
              },
        }),
      ]);
      await this.bumpDaily({
        trades: 1,
        realizedSol: pnlSol,
        wins: pnlSol > 0 ? 1 : 0,
        losses: pnlSol <= 0 ? 1 : 0,
      });
      this.lastTradeAt = Date.now();
      if (soldAll) void this.maybeGenerateStrategyReport();

      logger.info("executor", `SELL ${p.mint.slice(0, 8)}… ${kind} pnl ${pnlSol.toFixed(4)} SOL (${latencyMs}ms)`, {
        reason,
        signature: result.signature,
      });
      const event =
        kind === "take_profit" ? "profit_target" : kind === "stop_loss" ? "stop_loss" : kind === "rug_exit" ? "rug_warning" : "sell";
      void notify(
        event as Parameters<typeof notify>[0],
        `${kind.replace(/_/g, " ")} on ${p.symbol ?? p.mint.slice(0, 8) + "…"}`,
        `${reason}\nPnL: ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct?.toFixed(1) ?? "?"}%)`
      );
    } catch (e) {
      if (e instanceof SwapUncertainError) {
        logger.error("executor", `UNVERIFIED sell for position ${positionId} — check ${e.signature}; next monitor tick will reconcile`);
        void notify("wallet_issue", "Unverified sell — will reconcile", e.signature);
      } else {
        logger.exception("executor", `sell failed for position ${positionId} (will retry next tick)`, e);
        void notify("error", "Sell failed", (e as Error).message);
      }
    } finally {
      this.selling.delete(positionId);
      this.lastNarrativeCheck.delete(positionId);
    }
  }

  /**
   * Auto strategy report: every `reportEveryTrades` fully-closed trades,
   * generate the full analytics report (and auto-rebalance scoring weights
   * when enabled). Cheap check — one count + one findFirst — then the heavy
   * work runs at most once per threshold crossing.
   */
  private reportGenerating = false;
  private async maybeGenerateStrategyReport(): Promise<void> {
    if (this.reportGenerating || !dbResilience.healthy) return;
    this.reportGenerating = true;
    try {
      const settings = this.config.get();
      const [closedCount, lastReport] = await Promise.all([
        prisma.position.count({ where: { status: "CLOSED" } }),
        prisma.strategyReport.findFirst({ where: { trigger: "auto" }, orderBy: { at: "desc" } }),
      ]);
      const sinceLast = closedCount - (lastReport?.tradesAnalyzed ?? 0);
      if (sinceLast < settings.reportEveryTrades) return;
      await generateStrategyReport({
        mode: "all",
        trigger: "auto",
        autoApplyWeights: settings.autoRebalanceWeights,
      });
    } catch (e) {
      if (isTransientDbError(e)) dbResilience.recordFailure(e);
      else logger.warn("engine", `strategy report generation failed: ${(e as Error).message}`);
    } finally {
      this.reportGenerating = false;
    }
  }

  private async emergencyExitAll(): Promise<void> {
    const positions = await prisma.position.findMany({ where: { status: "OPEN" } }).catch((e) => {
      if (isTransientDbError(e)) dbResilience.recordFailure(e);
      logger.exception("engine", "emergency exit could not list open positions (will need re-triggering)", e);
      return [] as Awaited<ReturnType<typeof prisma.position.findMany>>;
    });
    for (const p of positions) {
      const price = (await getTokenPriceUsd(p.mint)) ?? p.entryPriceUsd ?? 0;
      await this.closePosition(p.id, price, 100, "rug_exit", "emergency stop — operator initiated");
    }
  }

  // ── data hygiene ──────────────────────────────────────────────────────────

  /** Archive old scanner data so the DB and dashboard stay fast. */
  private async archiveOldData(): Promise<void> {
    // Housekeeping can always wait for the next 6h tick — never probe a
    // database the circuit already knows is down.
    if (!dbResilience.healthy) return;
    const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86_400_000);
    try {
      const snapshots = await prisma.tokenSnapshot.deleteMany({ where: { at: { lt: cutoff } } });
      const scores = await prisma.scoreRecord.deleteMany({ where: { at: { lt: cutoff } } });
      await prisma.narrativeSnapshot.deleteMany({ where: { at: { lt: cutoff } } });
      // Trades keep their history (tokenId → SetNull); positions are never touched.
      const tokens = await prisma.detectedToken.deleteMany({
        where: {
          detectedAt: { lt: cutoff },
          verdict: { in: ["REJECTED", "IGNORED"] },
          trades: { none: {} },
        },
      });
      const logs = await prisma.logEntry.deleteMany({
        where: { at: { lt: new Date(Date.now() - 30 * 86_400_000) } },
      });
      if (snapshots.count || scores.count || tokens.count || logs.count) {
        logger.info(
          "engine",
          `archived: ${tokens.count} tokens, ${snapshots.count} snapshots, ${scores.count} scores, ${logs.count} logs (>${ARCHIVE_AFTER_DAYS}d)`
        );
      }
    } catch (e) {
      if (isTransientDbError(e)) dbResilience.recordFailure(e);
      else logger.exception("engine", "archival failed", e);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async riskState() {
    const [open, todayStats, lastLoss] = await Promise.all([
      prisma.position.findMany({ where: { status: "OPEN" } }),
      prisma.dailyStats.findUnique({ where: { date: todayUtc() } }),
      // Loss-cooldown anchor: most recent losing close (survives restarts).
      prisma.position.findFirst({
        where: { status: "CLOSED", pnlSol: { lte: 0 } },
        orderBy: { closedAt: "desc" },
        select: { closedAt: true },
      }),
    ]);
    return {
      openPositions: open.length,
      exposureSol: open.reduce((a, p) => a + p.entrySol, 0),
      dailyRealizedSol: todayStats?.realizedSol ?? 0,
      lastLossAt: lastLoss?.closedAt ?? null,
      emergencyStopped: this.emergencyStopped,
    };
  }

  private paperExecutor = new PaperExecutor(getTokenPriceUsd, getSolPriceUsd);
  private liveExecutor: LiveExecutor | null = null;

  private async getExecutor(paper: boolean): Promise<Executor> {
    if (paper) return this.paperExecutor;
    if (!this.liveExecutor) {
      const wallet = await prisma.wallet.findFirst({
        where: { encryptedKey: { not: null }, isWatchOnly: false },
      });
      if (!wallet?.encryptedKey) {
        throw new Error("live trading requires an imported bot wallet (Settings → Wallet)");
      }
      const encryptedKey = wallet.encryptedKey;
      this.liveExecutor = new LiveExecutor(this.conn, () =>
        // decrypted only at signing time, never cached
        Keypair.fromSecretKey(bs58.decode(decryptSecret(encryptedKey)))
      );
    }
    return this.liveExecutor;
  }

  private async bumpDaily(delta: Partial<{ scanned: number; bought: number; rejected: number; trades: number; wins: number; losses: number; realizedSol: number }>) {
    const date = todayUtc();
    await prisma.dailyStats.upsert({
      where: { date },
      create: { date, ...normalizeDelta(delta) },
      update: {
        scanned: { increment: delta.scanned ?? 0 },
        bought: { increment: delta.bought ?? 0 },
        rejected: { increment: delta.rejected ?? 0 },
        trades: { increment: delta.trades ?? 0 },
        wins: { increment: delta.wins ?? 0 },
        losses: { increment: delta.losses ?? 0 },
        realizedSol: { increment: delta.realizedSol ?? 0 },
      },
    }).catch((e) => {
      if (isTransientDbError(e)) dbResilience.recordFailure(e);
      else logger.warn("engine", `daily stats update failed: ${(e as Error).message}`);
    });
  }
}

function todayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function normalizeDelta(d: Record<string, number | undefined>) {
  return {
    scanned: d.scanned ?? 0,
    bought: d.bought ?? 0,
    rejected: d.rejected ?? 0,
    trades: d.trades ?? 0,
    wins: d.wins ?? 0,
    losses: d.losses ?? 0,
    realizedSol: d.realizedSol ?? 0,
  };
}

// ── entrypoint ──────────────────────────────────────────────────────────────

// @solana/web3.js prints every websocket reconnect failure straight to
// console.error ("ws error: …") with no way to configure it, flooding logs
// during an RPC outage. Throttle that one message to once per minute; every
// other console.error passes through untouched (the health probe still
// surfaces RPC trouble on the dashboard).
const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("ws error")) {
    if (Date.now() - lastWsErrorAt < 60_000) return;
    lastWsErrorAt = Date.now();
  }
  rawConsoleError(...args);
};

validateEnv("engine");
const engine = new TradingEngine();

// No silent failures: anything unhandled is logged with a stack trace, then
// the process exits so the supervisor (docker restart: always) restarts it
// and crash recovery rebuilds state from Postgres.
process.on("unhandledRejection", (reason) => {
  logger.exception("engine", "unhandled rejection", reason);
});
process.on("uncaughtException", (err) => {
  logger.exception("engine", "uncaught exception — exiting for supervisor restart", err);
  setTimeout(() => process.exit(1), 500);
});

async function main() {
  await engine.start();
  const shutdown = async (sig: string) => {
    logger.info("engine", `${sig} received, shutting down`);
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.exception("engine", "fatal startup error", e);
  process.exit(1);
});
