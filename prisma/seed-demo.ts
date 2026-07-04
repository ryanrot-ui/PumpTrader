/* Demo data seeder — populates the dashboard for screenshots. */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const now = Date.now();
const min = 60_000;

function breakdown(overall: number) {
  const metrics = [
    "liquidity", "marketCap", "volume", "volumeGrowth", "buyPressure", "holders",
    "holderGrowth", "distribution", "walletQuality", "momentum", "stability", "safety", "activity",
  ];
  return metrics.map((m, i) => {
    const value = Math.max(0.05, Math.min(1, overall / 100 + Math.sin(i * 2.7) * 0.18));
    const weight = [10, 5, 8, 6, 9, 7, 6, 12, 9, 7, 6, 12, 3][i];
    const details: Record<string, string> = {
      liquidity: "214 SOL pooled", marketCap: "$412,000 mcap", volume: "$38,400 5m volume",
      volumeGrowth: "+64% 5m volume growth", buyPressure: "buy/sell ratio 2.31", holders: "587 holders",
      holderGrowth: "42 new holders / 5m", distribution: "top holder 2.4%, top10 13.8%, dev holds 0.9%",
      walletQuality: "11% fresh wallets, 2 snipers, 0 bundled wallets", momentum: "momentum 1.24%/min",
      stability: "liq +4%, volatility 3.1%, ~0.9% slippage/1 SOL", safety: "mint revoked, freeze revoked, LP 100% burned/locked",
      activity: "58 tx/min",
    };
    return { metric: m, value, weight, contribution: value * weight, detail: details[m] };
  });
}

const GREEN = ["Strong liquidity", "Healthy holder growth", "Strong buy pressure", "Increasing volume",
  "Healthy wallet distribution", "No whale dominance", "No suspicious developer allocation",
  "Positive momentum", "Organic wallet creation", "Stable liquidity", "Good transaction velocity",
  "Mint & freeze authority revoked", "LP burned/locked"];

async function main() {
  await prisma.trade.deleteMany();
  await prisma.position.deleteMany();
  await prisma.scoreRecord.deleteMany();
  await prisma.tokenSnapshot.deleteMany();
  await prisma.detectedToken.deleteMany();
  await prisma.logEntry.deleteMany();
  await prisma.dailyStats.deleteMany();

  const tokens = [
    { mint: "GLXYb4nQx7JmVprA2eDf8sKt3WqHcyU5oPzR6iBmshdC", symbol: "GLXY", score: 91, verdict: "BOUGHT", ageMin: 22, green: GREEN.slice(0, 11), red: [] as string[], critical: false, rej: [] as string[] },
    { mint: "MOONr8kEw2TnXbcJ9qLs5vAy7DfGh4mZpUiK3oWtsvhP", symbol: "MOONR", score: 88, verdict: "BOUGHT", ageMin: 96, green: GREEN.slice(0, 9), red: [], critical: false, rej: [] },
    { mint: "PEPEv6tRj9WqLmXa3cNd7yKf2sBg8hEzUoP4iAnwkfhT", symbol: "PEPEV", score: 74, verdict: "REJECTED", ageMin: 9, green: GREEN.slice(0, 5), red: ["Wallet concentration"], critical: false, rej: ["score 74 below threshold 85", "holders 84 below minimum 100"] },
    { mint: "DOGWx2mSk5YpQrTb8eJf4uLc6vNh9gAzEiU7oKdmwthR", symbol: "DOGW", score: 31, verdict: "REJECTED", ageMin: 14, green: [], red: ["Large insider allocation", "Wallet concentration", "Massive sniper activity", "Bundled wallets"], critical: false, rej: ["score 31 below threshold 85", "liquidity 18.2 SOL below minimum 50"] },
    { mint: "RUGGp9qTn3XcVaWd6fKj8yLs2mBe5hGzUoI4iPnyudhS", symbol: "RUGG", score: 4, verdict: "REJECTED", ageMin: 31, green: [], red: ["Liquidity being removed", "Developer dumping", "Freeze authority active"], critical: true, rej: ["critical red flag: Liquidity being removed, Developer dumping, Freeze authority active"] },
    { mint: "STARk5wUv8ZqMnYc4dJg7tLf3xBh6eAzRiO9oPmzvchQ", symbol: "STAR", score: 82, verdict: null, ageMin: 3, green: GREEN.slice(0, 7), red: [], critical: false, rej: [] },
    { mint: "NEONj3xTw6VqPmXa9cKf5uLd8yBg2hFzEiU7oRnwabhM", symbol: "NEON", score: 67, verdict: "REJECTED", ageMin: 41, green: GREEN.slice(0, 4), red: ["Excessive volatility"], critical: false, rej: ["score 67 below threshold 85", "buy momentum not increasing (-0.42%/min)"] },
    { mint: "FLUXm7yVs4WrNnZb2eLh9uMg6xCk3fBzTiP8oQdxwehN", symbol: "FLUX", score: 58, verdict: "REJECTED", ageMin: 55, green: GREEN.slice(0, 3), red: ["Artificial volume", "Spam / fresh-wallet swarm"], critical: false, rej: ["score 58 below threshold 85", "5m volume $3,120 below minimum $5000"] },
  ];

  for (const t of tokens) {
    const detectedAt = new Date(now - t.ageMin * min);
    const row = await prisma.detectedToken.create({
      data: {
        mint: t.mint, symbol: t.symbol, migratedAt: detectedAt, detectedAt,
        score: t.score, verdict: t.verdict, rejectionReasons: t.rej,
      },
    });
    await prisma.scoreRecord.create({
      data: {
        tokenId: row.id, total: t.score, breakdown: breakdown(t.score) as object,
        greenFlags: t.green, redFlags: t.red, critical: t.critical,
      },
    });
    // price history for the chart (organic-looking walk)
    const basePrice = 0.00012 + Math.random() * 0.0004;
    let price = basePrice;
    const steps = Math.min(t.ageMin, 60);
    for (let i = steps; i >= 0; i--) {
      const drift = t.verdict === "BOUGHT" ? 0.018 : t.critical ? -0.05 : 0.002;
      price = Math.max(basePrice * 0.2, price * (1 + drift + (Math.random() - 0.5) * 0.06));
      await prisma.tokenSnapshot.create({
        data: {
          tokenId: row.id, at: new Date(now - i * min), priceUsd: price,
          liquiditySol: 180 + Math.random() * 80, marketCapUsd: price * 1e9,
          volume5mUsd: 20_000 + Math.random() * 30_000,
          holderCount: 400 + Math.round((steps - i) * 6), txPerMinute: 40 + Math.random() * 30,
          buySellRatio: 1.6 + Math.random(),
        },
      });
    }
  }

  // Positions: 1 open (GLXY, up 34%), 4 closed
  const glxy = await prisma.detectedToken.findUniqueOrThrow({ where: { mint: tokens[0].mint } });
  const moonr = await prisma.detectedToken.findUniqueOrThrow({ where: { mint: tokens[1].mint } });

  const openPos = await prisma.position.create({
    data: {
      mint: glxy.mint, symbol: "GLXY", status: "OPEN", paper: true,
      entrySol: 0.1, entryPriceUsd: 0.00031, peakPriceUsd: 0.00046, tokenQty: 48_000,
      entryReason: "score 91: strong liquidity; healthy holder growth; strong buy pressure; increasing volume; no whale dominance; positive momentum",
      openedAt: new Date(now - 18 * min),
    },
  });
  await prisma.trade.create({
    data: {
      tokenId: glxy.id, positionId: openPos.id, side: "BUY", paper: true,
      amountSol: 0.1, tokenQty: 48_000, priceUsd: 0.00031,
      reason: "score 91: strong liquidity; healthy holder growth; strong buy pressure",
      createdAt: new Date(now - 18 * min),
    },
  });

  const closed = [
    { sym: "MOONR", token: moonr, entry: 0.1, pnl: 0.1006, pct: 100.6, kind: "take profit: +100.6% ≥ +100% target", hrsAgo: 3 },
    { sym: "MOONR", token: moonr, entry: 0.1, pnl: 0.052, pct: 52.4, kind: "trailing stop: 20.3% off peak (limit 20%), locking 52.4%", hrsAgo: 26 },
    { sym: "MOONR", token: moonr, entry: 0.1, pnl: -0.0301, pct: -30.1, kind: "stop loss: -30.1% ≤ -30%", hrsAgo: 49 },
    { sym: "MOONR", token: moonr, entry: 0.1, pnl: 0.0871, pct: 87.3, kind: "time exit: held 240 min ≥ 240 min (pnl 87.3%)", hrsAgo: 74 },
  ];
  for (const c of closed) {
    const opened = new Date(now - c.hrsAgo * 60 * min - 90 * min);
    const closedAt = new Date(now - c.hrsAgo * 60 * min);
    const pos = await prisma.position.create({
      data: {
        mint: c.token.mint, symbol: c.sym, status: "CLOSED", paper: true,
        entrySol: c.entry, entryPriceUsd: 0.0002, peakPriceUsd: 0.00042, tokenQty: 70_000,
        exitSol: c.entry + c.pnl, exitPriceUsd: 0.0002 * (1 + c.pct / 100),
        pnlSol: c.pnl, pnlPct: c.pct,
        entryReason: "score 88: strong liquidity; healthy holder growth; strong buy pressure; stable liquidity",
        exitReason: c.kind, openedAt: opened, closedAt,
      },
    });
    await prisma.trade.createMany({
      data: [
        { tokenId: c.token.id, positionId: pos.id, side: "BUY", paper: true, amountSol: c.entry, tokenQty: 70_000, priceUsd: 0.0002, reason: pos.entryReason, createdAt: opened },
        { tokenId: c.token.id, positionId: pos.id, side: "SELL", paper: true, amountSol: c.entry + c.pnl, tokenQty: 70_000, priceUsd: pos.exitPriceUsd!, reason: c.kind, createdAt: closedAt },
      ],
    });
  }

  // Daily stats — 7 days of history for the PnL graph
  const daily = [
    { d: 6, r: -0.021, t: 3, w: 1, l: 2, s: 118, b: 3 },
    { d: 5, r: 0.087, t: 2, w: 2, l: 0, s: 134, b: 2 },
    { d: 4, r: 0.0, t: 0, w: 0, l: 0, s: 96, b: 0 },
    { d: 3, r: 0.0871, t: 1, w: 1, l: 0, s: 141, b: 1 },
    { d: 2, r: -0.0301, t: 1, w: 0, l: 1, s: 122, b: 1 },
    { d: 1, r: 0.052, t: 1, w: 1, l: 0, s: 157, b: 1 },
    { d: 0, r: 0.1006, t: 2, w: 1, l: 0, s: 89, b: 2 },
  ];
  for (const x of daily) {
    const date = new Date(now - x.d * 86400_000);
    await prisma.dailyStats.create({
      data: {
        date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
        realizedSol: x.r, trades: x.t, wins: x.w, losses: x.l, scanned: x.s, bought: x.b, rejected: x.s - x.b,
      },
    });
  }

  // Logs
  const logs: Array<[string, string, string, number]> = [
    ["info", "scanner", "migration detected: STARk5wUv8ZqMnYc4dJg7tLf3xBh6eAzRiO9oPmzvchQ", 3],
    ["info", "scoring", "STAR scored 82 — evaluating (age 3m, waiting for settle window)", 2],
    ["warn", "risk", "buy blocked for RUGGp9qT… — critical red flag: Liquidity being removed", 28],
    ["info", "executor", "BUY GLXYb4nQ… 0.1 SOL (paper) — score 91", 18],
    ["info", "executor", "SELL MOONr8kE… take_profit pnl +0.1006 SOL", 180],
    ["info", "engine", "settings reloaded", 45],
    ["debug", "scoring", "rejected DOGWx2mS… (31) — liquidity 18.2 SOL below minimum 50", 13],
    ["info", "scanner", "migration detected: GLXYb4nQx7JmVprA2eDf8sKt3WqHcyU5oPzR6iBmshdC", 22],
  ];
  for (const [level, source, message, minsAgo] of logs) {
    await prisma.logEntry.create({
      data: { level, source, message, at: new Date(now - minsAgo * min) },
    });
  }

  console.log("seeded demo data");
}

main().finally(() => prisma.$disconnect());
