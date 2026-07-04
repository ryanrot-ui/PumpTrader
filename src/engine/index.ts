import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { prisma } from "@/lib/prisma";
import { redis, KEYS } from "@/lib/redis";
import { decryptSecret } from "@/lib/crypto";
import {
  collectMetrics,
  forgetToken,
  getPoolLiquidityUsd,
  getSolPriceUsd,
  getTokenPriceUsd,
} from "./analysis/collectors";
import { scoreToken } from "./analysis/scoring";
import { MigrationScanner, type MigrationEvent } from "./scanner/migrationScanner";
import { evaluateBuyRules } from "./trading/rules";
import { checkRisk } from "./trading/riskManager";
import { evaluateExit } from "./trading/exitRules";
import { LiveExecutor, PaperExecutor, type Executor } from "./trading/executor";
import { LiveConfig } from "./config";
import { logger } from "./logging/logger";
import { notify } from "./notify";

/**
 * Trading engine worker — run separately from the web app:
 *   npm run engine        (mode from settings; paper by default)
 *
 * Lifecycle:
 *   scanner detects migration → token joins the watchlist → evaluated every
 *   EVAL_INTERVAL until WATCH_WINDOW expires → if score + rules + risk all
 *   pass, buy → position monitored every MONITOR_INTERVAL until an exit rule
 *   fires.
 *
 * Crash recovery: open positions and the watchlist are persisted in Postgres
 * and reloaded on startup; the scanner's polling fallback re-detects
 * migrations missed while down.
 */

const EVAL_INTERVAL_MS = 15_000;
const MONITOR_INTERVAL_MS = 5_000;
const WATCH_WINDOW_MS = 45 * 60_000; // stop evaluating tokens older than this
const MIN_AGE_BEFORE_BUY_S = 90; // let post-migration chaos settle first

interface WatchedToken {
  tokenId: string;
  mint: string;
  migratedAt: Date;
  evaluating: boolean;
}

class TradingEngine {
  private conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", {
    wsEndpoint: process.env.SOLANA_WS_URL,
    commitment: "confirmed",
  });
  private config = new LiveConfig();
  private scanner: MigrationScanner;
  private control = redis.duplicate();
  private watchlist = new Map<string, WatchedToken>();
  private buying = new Set<string>(); // in-flight buy locks (duplicate guard)
  private selling = new Set<string>();
  private emergencyStopped = false;
  private timers: NodeJS.Timeout[] = [];

  constructor() {
    this.scanner = new MigrationScanner(
      this.conn,
      (e) => this.onMigration(e),
      (err, ctx) => logger.error("scanner", `${ctx}: ${err.message}`)
    );
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("engine", "starting trading engine");
    await this.config.start();

    // Crash recovery: resume open positions and recent unresolved tokens
    const openPositions = await prisma.position.count({ where: { status: "OPEN" } });
    const recent = await prisma.detectedToken.findMany({
      where: {
        detectedAt: { gte: new Date(Date.now() - WATCH_WINDOW_MS) },
        verdict: { notIn: ["BOUGHT", "IGNORED"] },
      },
    });
    for (const t of recent) {
      this.watchlist.set(t.mint, {
        tokenId: t.id,
        mint: t.mint,
        migratedAt: t.migratedAt,
        evaluating: false,
      });
    }
    logger.info("engine", `recovered ${openPositions} open position(s), ${recent.length} watched token(s)`);

    await this.scanner.start();
    await this.control.subscribe(KEYS.controlChannel);
    this.control.on("message", (_ch, msg) => this.onControl(msg));

    this.timers.push(setInterval(() => void this.evaluateWatchlist(), EVAL_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.monitorPositions(), MONITOR_INTERVAL_MS));
    this.timers.push(
      setInterval(() => void redis.set(KEYS.botHeartbeat, Date.now().toString()).catch(() => {}), 5_000)
    );
    await redis.set(KEYS.botStatus, "running");
    logger.info("engine", "engine running — scanning for Pump.fun migrations");
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.scanner.stop();
    await this.config.stop();
    await redis.set(KEYS.botStatus, "stopped").catch(() => {});
    this.control.disconnect();
    logger.info("engine", "engine stopped");
  }

  private onControl(msg: string): void {
    if (msg === "emergency_stop") {
      this.emergencyStopped = true;
      void redis.set(KEYS.botStatus, "emergency_stopped");
      logger.warn("engine", "EMERGENCY STOP received — no new buys; exiting all positions");
      void this.emergencyExitAll();
    } else if (msg === "resume") {
      this.emergencyStopped = false;
      void redis.set(KEYS.botStatus, "running");
      logger.info("engine", "resumed from emergency stop");
    }
  }

  // ── scanning & evaluation ─────────────────────────────────────────────────

  private async onMigration(e: MigrationEvent): Promise<void> {
    if (this.watchlist.has(e.mint)) return;
    const token = await prisma.detectedToken.upsert({
      where: { mint: e.mint },
      update: {},
      create: {
        mint: e.mint,
        poolAddress: e.poolAddress,
        migratedAt: e.migratedAt,
        verdict: null,
      },
    });
    this.watchlist.set(e.mint, {
      tokenId: token.id,
      mint: e.mint,
      migratedAt: e.migratedAt,
      evaluating: false,
    });
    await this.bumpDaily({ scanned: 1 });
    logger.info("scanner", `migration detected: ${e.mint}`, {
      pool: e.poolAddress,
      signature: e.signature,
    });
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
    try {
      const age = Date.now() - t.migratedAt.getTime();
      if (age > WATCH_WINDOW_MS) {
        this.watchlist.delete(t.mint);
        forgetToken(t.mint);
        await prisma.detectedToken.update({
          where: { id: t.tokenId },
          data: { verdict: "IGNORED", rejectionReasons: ["watch window expired"] },
        });
        return;
      }

      const settings = this.config.get();
      const metrics = await collectMetrics(this.conn, t.mint, t.migratedAt);
      const score = scoreToken(metrics);

      await prisma.$transaction([
        prisma.scoreRecord.create({
          data: {
            tokenId: t.tokenId,
            total: score.total,
            breakdown: JSON.parse(JSON.stringify(score.metrics)),
            greenFlags: score.greenFlags.map((f) => f.label),
            redFlags: score.redFlags.map((f) => f.label),
            critical: score.criticalFlags.length > 0,
          },
        }),
        prisma.tokenSnapshot.create({
          data: {
            tokenId: t.tokenId,
            priceUsd: metrics.priceUsd,
            liquiditySol: metrics.liquiditySol,
            marketCapUsd: metrics.marketCapUsd,
            volume5mUsd: metrics.volume5mUsd,
            holderCount: metrics.holderCount,
            txPerMinute: metrics.txPerMinute,
            buySellRatio: metrics.buySellRatio,
          },
        }),
        prisma.detectedToken.update({
          where: { id: t.tokenId },
          data: { score: score.total },
        }),
      ]);

      if (score.total >= 90) {
        void notify("high_score_token", `High score: ${t.mint.slice(0, 8)}…`, score.explanation);
      }

      if (metrics.ageSinceMigrationSec < MIN_AGE_BEFORE_BUY_S) return; // let it settle

      const decision = evaluateBuyRules(metrics, score, settings);
      if (!decision.buy) {
        await prisma.detectedToken.update({
          where: { id: t.tokenId },
          data: { verdict: "REJECTED", rejectionReasons: decision.reasons },
        });
        logger.debug("scoring", `rejected ${t.mint.slice(0, 8)}… (${score.total})`, {
          reasons: decision.reasons,
        });
        return;
      }

      await this.tryBuy(t, metrics.priceUsd, score.total, decision.reasons);
    } catch (e) {
      logger.error("scoring", `evaluate ${t.mint.slice(0, 8)}… failed: ${(e as Error).message}`);
    } finally {
      t.evaluating = false;
    }
  }

  // ── buying ────────────────────────────────────────────────────────────────

  private async tryBuy(
    t: WatchedToken,
    priceUsd: number | null,
    score: number,
    reasons: string[]
  ): Promise<void> {
    if (this.buying.has(t.mint)) return; // duplicate guard
    const settings = this.config.get();

    const existing = await prisma.position.findFirst({
      where: { mint: t.mint, status: "OPEN" },
    });
    if (existing) return;

    const risk = checkRisk(settings, await this.riskState());
    if (!risk.allowed) {
      logger.info("risk", `buy blocked for ${t.mint.slice(0, 8)}…`, { reasons: risk.reasons });
      return;
    }

    this.buying.add(t.mint);
    try {
      const executor = await this.getExecutor(settings.paperTrading);
      const entryReason = `score ${score}: ${reasons.join("; ")}`;
      const result = await executor.buy(t.mint, risk.sizeSol, settings.maxSlippageBps);
      // paper: UI token quantity; live: token base units (sold back in the same unit)
      const tokenQty = result.outAmount;

      const position = await prisma.position.create({
        data: {
          mint: t.mint,
          status: "OPEN",
          paper: result.paper,
          entrySol: risk.sizeSol,
          entryPriceUsd: priceUsd,
          peakPriceUsd: priceUsd,
          tokenQty,
          entryReason,
        },
      });
      await prisma.trade.create({
        data: {
          tokenId: t.tokenId,
          positionId: position.id,
          side: "BUY",
          paper: result.paper,
          amountSol: risk.sizeSol,
          tokenQty,
          priceUsd,
          signature: result.signature,
          reason: entryReason,
        },
      });
      await prisma.detectedToken.update({
        where: { id: t.tokenId },
        data: { verdict: "BOUGHT" },
      });
      await this.bumpDaily({ bought: 1, trades: 1 });
      this.watchlist.delete(t.mint);

      logger.info("executor", `BUY ${t.mint.slice(0, 8)}… ${risk.sizeSol} SOL (${result.paper ? "paper" : "live"})`, {
        signature: result.signature,
        reason: entryReason,
      });
      void notify(
        "buy",
        `Bought ${t.mint.slice(0, 8)}… (${result.paper ? "paper" : "LIVE"})`,
        `${risk.sizeSol} SOL @ $${priceUsd?.toPrecision(4) ?? "?"}\n${entryReason}`
      );
    } catch (e) {
      logger.error("executor", `buy ${t.mint.slice(0, 8)}… failed: ${(e as Error).message}`);
      void notify("error", "Buy failed", `${t.mint}: ${(e as Error).message}`);
    } finally {
      this.buying.delete(t.mint);
    }
  }

  // ── position monitoring ───────────────────────────────────────────────────

  private async monitorPositions(): Promise<void> {
    const positions = await prisma.position.findMany({ where: { status: "OPEN" } });
    if (positions.length === 0) return;
    const settings = this.config.get();

    await Promise.allSettled(
      positions.map(async (p) => {
        if (this.selling.has(p.id)) return;
        const price = await getTokenPriceUsd(p.mint);
        if (!price || !p.entryPriceUsd) return;

        const peak = Math.max(p.peakPriceUsd ?? price, price);
        if (peak !== p.peakPriceUsd) {
          await prisma.position.update({ where: { id: p.id }, data: { peakPriceUsd: peak } });
        }

        // liquidity drop since entry → rug signal
        let liquidityDropPct: number | null = null;
        const liqNow = await getPoolLiquidityUsd(p.mint);
        const liqKey = `pos:${p.id}:entryLiq`;
        if (liqNow !== null) {
          const stored = await redis.get(liqKey);
          if (!stored) await redis.set(liqKey, liqNow.toString(), "EX", 7 * 86400);
          else liquidityDropPct = ((liqNow - parseFloat(stored)) / parseFloat(stored)) * 100;
        }

        const decision = evaluateExit(settings, {
          entryPriceUsd: p.entryPriceUsd,
          currentPriceUsd: price,
          peakPriceUsd: peak,
          openedAt: p.openedAt,
          liquidityDropPct,
        });
        if (decision.exit) {
          await this.closePosition(p.id, price, decision.portionPct, decision.kind!, decision.reason);
        }
      })
    );
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
    try {
      const p = await prisma.position.findUnique({ where: { id: positionId } });
      if (!p || p.status !== "OPEN") return;

      const settings = this.config.get();
      const executor = await this.getExecutor(p.paper);
      const sellQty = p.tokenQty * (portionPct / 100);
      const result = await executor.sell(p.mint, sellQty, settings.maxSlippageBps);
      const receivedSol = result.outAmount / 1_000_000_000;

      const soldAll = portionPct >= 99.999;
      const proportionalEntry = p.entrySol * (portionPct / 100);
      const pnlSol = receivedSol - proportionalEntry;
      const pnlPct = p.entryPriceUsd ? ((priceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100 : null;

      const token = await prisma.detectedToken.findUnique({ where: { mint: p.mint } });
      await prisma.trade.create({
        data: {
          tokenId: token?.id ?? "",
          positionId: p.id,
          side: "SELL",
          paper: p.paper,
          amountSol: receivedSol,
          tokenQty: sellQty,
          priceUsd,
          signature: result.signature,
          reason,
        },
      });
      await prisma.position.update({
        where: { id: p.id },
        data: soldAll
          ? {
              status: "CLOSED",
              exitSol: receivedSol,
              exitPriceUsd: priceUsd,
              pnlSol,
              pnlPct,
              exitReason: reason,
              closedAt: new Date(),
            }
          : { tokenQty: p.tokenQty - sellQty, entrySol: p.entrySol - proportionalEntry },
      });
      await this.bumpDaily({
        trades: 1,
        realizedSol: pnlSol,
        wins: pnlSol > 0 ? 1 : 0,
        losses: pnlSol <= 0 ? 1 : 0,
      });
      if (pnlSol <= 0) await redis.set("risk:lastLossAt", Date.now().toString());

      logger.info("executor", `SELL ${p.mint.slice(0, 8)}… ${kind} pnl ${pnlSol.toFixed(4)} SOL`, {
        reason,
        signature: result.signature,
      });
      const event = kind === "take_profit" ? "profit_target" : kind === "stop_loss" ? "stop_loss" : kind === "rug_exit" ? "rug_warning" : "sell";
      void notify(
        event as Parameters<typeof notify>[0],
        `${kind.replace("_", " ")} on ${p.mint.slice(0, 8)}…`,
        `${reason}\nPnL: ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${pnlPct?.toFixed(1) ?? "?"}%)`
      );
    } catch (e) {
      logger.error("executor", `sell failed for position ${positionId}: ${(e as Error).message}`);
      void notify("error", "Sell failed", (e as Error).message);
    } finally {
      this.selling.delete(positionId);
    }
  }

  private async emergencyExitAll(): Promise<void> {
    const positions = await prisma.position.findMany({ where: { status: "OPEN" } });
    for (const p of positions) {
      const price = (await getTokenPriceUsd(p.mint)) ?? p.entryPriceUsd ?? 0;
      await this.closePosition(p.id, price, 100, "rug_exit", "emergency stop — operator initiated");
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async riskState() {
    const [open, todayStats, lastLoss] = await Promise.all([
      prisma.position.findMany({ where: { status: "OPEN" } }),
      prisma.dailyStats.findUnique({ where: { date: todayUtc() } }),
      redis.get("risk:lastLossAt"),
    ]);
    return {
      openPositions: open.length,
      exposureSol: open.reduce((a, p) => a + p.entrySol, 0),
      dailyRealizedSol: todayStats?.realizedSol ?? 0,
      lastLossAt: lastLoss ? new Date(parseInt(lastLoss, 10)) : null,
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
    }).catch((e) => logger.warn("engine", `daily stats update failed: ${(e as Error).message}`));
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

const engine = new TradingEngine();

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
  logger.error("engine", `fatal: ${(e as Error).message}`);
  // Crash recovery is handled by the process supervisor (docker restart:
  // always / systemd Restart=on-failure); state is rebuilt from Postgres.
  process.exit(1);
});
