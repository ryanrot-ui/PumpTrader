import { Connection, PublicKey } from "@solana/web3.js";
import type { TokenMetrics } from "./types";

/**
 * Metric collectors. Each source is independent and failure-tolerant: when a
 * source errors or is not configured, its fields stay null and the source is
 * recorded in `missingSources` so the scoring engine treats them as neutral.
 *
 * Sources:
 *  - DexScreener public API — price, liquidity, volume, buy/sell counts
 *  - Solana RPC             — mint authorities, largest holders, supply
 *  - Helius (optional)      — wallet-age heuristics for fresh/sniper wallets
 */

const DEXSCREENER = "https://api.dexscreener.com";
const SOL_PRICE_FALLBACK = 150;

interface Snapshot {
  at: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  holderCount: number | null;
}

/** Rolling per-token history used for growth/momentum/volatility metrics. */
const history = new Map<string, Snapshot[]>();
const MAX_HISTORY = 60;

export function rememberSnapshot(mint: string, snap: Snapshot) {
  const arr = history.get(mint) ?? [];
  arr.push(snap);
  if (arr.length > MAX_HISTORY) arr.shift();
  history.set(mint, arr);
}

export function forgetToken(mint: string) {
  history.delete(mint);
}

async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ── DexScreener ─────────────────────────────────────────────────────────────

interface DexPair {
  pairAddress: string;
  dexId: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { m5?: number; h1?: number };
  priceChange?: { m5?: number; h1?: number };
  txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number } };
  pairCreatedAt?: number;
}

async function collectDexScreener(mint: string, m: TokenMetrics): Promise<void> {
  const data = await fetchJson<{ pairs: DexPair[] | null }>(
    `${DEXSCREENER}/latest/dex/tokens/${mint}`
  );
  const pairs = (data.pairs ?? []).filter((p) => p.dexId === "raydium");
  if (pairs.length === 0) throw new Error("no raydium pair yet");
  // Use the deepest Raydium pool
  const pair = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  m.poolAddress = m.poolAddress ?? pair.pairAddress;
  m.priceUsd = pair.priceUsd ? parseFloat(pair.priceUsd) : null;
  m.liquidityUsd = pair.liquidity?.usd ?? null;
  m.liquiditySol = m.liquidityUsd !== null ? m.liquidityUsd / (await solPriceUsd()) : null;
  m.marketCapUsd = pair.marketCap ?? pair.fdv ?? null;
  m.volume5mUsd = pair.volume?.m5 ?? null;
  m.volume1hUsd = pair.volume?.h1 ?? null;
  m.priceChange5mPct = pair.priceChange?.m5 ?? null;
  m.priceChange1hPct = pair.priceChange?.h1 ?? null;
  m.buys5m = pair.txns?.m5?.buys ?? null;
  m.sells5m = pair.txns?.m5?.sells ?? null;
  if (m.buys5m !== null && m.sells5m !== null) {
    m.buySellRatio = m.buys5m / Math.max(m.sells5m, 1);
    m.txPerMinute = (m.buys5m + m.sells5m) / 5;
  }
}

let solPriceCache: { at: number; price: number } | null = null;
async function solPriceUsd(): Promise<number> {
  if (solPriceCache && Date.now() - solPriceCache.at < 60_000) return solPriceCache.price;
  try {
    const data = await fetchJson<{ pairs: DexPair[] | null }>(
      `${DEXSCREENER}/latest/dex/tokens/So11111111111111111111111111111111111111112`
    );
    const p = data.pairs?.find((x) => x.priceUsd);
    const price = p?.priceUsd ? parseFloat(p.priceUsd) : SOL_PRICE_FALLBACK;
    solPriceCache = { at: Date.now(), price };
    return price;
  } catch {
    return solPriceCache?.price ?? SOL_PRICE_FALLBACK;
  }
}

/** Lightweight price lookup for position monitoring (deepest Raydium pair). */
export async function getTokenPriceUsd(mint: string): Promise<number | null> {
  try {
    const data = await fetchJson<{ pairs: DexPair[] | null }>(
      `${DEXSCREENER}/latest/dex/tokens/${mint}`
    );
    const pair = (data.pairs ?? [])
      .filter((p) => p.dexId === "raydium" && p.priceUsd)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
  } catch {
    return null;
  }
}

/** Liquidity (USD) of the deepest Raydium pair — used for rug monitoring. */
export async function getPoolLiquidityUsd(mint: string): Promise<number | null> {
  try {
    const data = await fetchJson<{ pairs: DexPair[] | null }>(
      `${DEXSCREENER}/latest/dex/tokens/${mint}`
    );
    const pair = (data.pairs ?? [])
      .filter((p) => p.dexId === "raydium")
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return pair?.liquidity?.usd ?? null;
  } catch {
    return null;
  }
}

export { solPriceUsd as getSolPriceUsd };

// ── On-chain (RPC) ──────────────────────────────────────────────────────────

async function collectOnChain(conn: Connection, mint: string, m: TokenMetrics): Promise<void> {
  const mintPk = new PublicKey(mint);

  const info = await conn.getParsedAccountInfo(mintPk, "confirmed");
  const parsed = info.value?.data as
    | { parsed?: { info?: { mintAuthority: string | null; freezeAuthority: string | null; supply: string; decimals: number } } }
    | undefined;
  const mi = parsed?.parsed?.info;
  if (mi) {
    m.mintAuthorityRevoked = mi.mintAuthority === null;
    m.freezeAuthorityRevoked = mi.freezeAuthority === null;
  }

  // Top holders (largest token accounts; index 0 is usually the Raydium vault)
  const largest = await conn.getTokenLargestAccounts(mintPk, "confirmed");
  const supplyRes = await conn.getTokenSupply(mintPk, "confirmed");
  const supply = supplyRes.value.uiAmount ?? null;
  if (supply && largest.value.length > 0) {
    const amounts = largest.value.map((a) => a.uiAmount ?? 0);
    // Heuristic: the single largest account is the pool vault — exclude it.
    const [, ...nonPool] = amounts.sort((a, b) => b - a);
    if (nonPool.length > 0) {
      m.topHolderPct = (nonPool[0] / supply) * 100;
      m.top10HolderPct = (nonPool.slice(0, 10).reduce((a, b) => a + b, 0) / supply) * 100;
    }
  }
}

// ── Helius (optional enrichment) ────────────────────────────────────────────

async function collectHelius(mint: string, m: TokenMetrics): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY not set");

  // Holder count via getTokenAccounts (paginated; first page is enough to
  // know if we cross typical thresholds, full count up to 10k)
  let holderCount = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenAccounts",
        params: { mint, limit: 1000, cursor, options: { showZeroBalance: false } },
      }),
    });
    if (!res.ok) throw new Error(`helius HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: { token_accounts?: unknown[]; cursor?: string };
    };
    const accounts = json.result?.token_accounts ?? [];
    holderCount += accounts.length;
    cursor = json.result?.cursor;
    if (!cursor || accounts.length < 1000) break;
  }
  m.holderCount = holderCount;
}

// ── Derived metrics from history ────────────────────────────────────────────

function deriveFromHistory(mint: string, m: TokenMetrics): void {
  const arr = history.get(mint) ?? [];
  if (arr.length === 0) return;

  const first = arr[0];
  const prev5m = arr.filter((s) => Date.now() - s.at >= 5 * 60_000).pop();

  if (m.liquidityUsd !== null && first.liquidityUsd) {
    m.liquidityChangePct = ((m.liquidityUsd - first.liquidityUsd) / first.liquidityUsd) * 100;
  }
  if (m.volume5mUsd !== null && prev5m?.volume5mUsd) {
    m.volumeGrowthPct = ((m.volume5mUsd - prev5m.volume5mUsd) / prev5m.volume5mUsd) * 100;
  }
  if (m.holderCount !== null && prev5m?.holderCount != null) {
    m.holderGrowth5m = m.holderCount - prev5m.holderCount;
  }

  // Momentum: %/min over the last ~3 minutes of samples
  const recent = arr.filter((s) => Date.now() - s.at <= 3 * 60_000 && s.priceUsd);
  if (recent.length >= 2 && m.priceUsd) {
    const oldest = recent[0];
    const minutes = Math.max((Date.now() - oldest.at) / 60_000, 0.5);
    m.momentum = ((m.priceUsd - oldest.priceUsd!) / oldest.priceUsd!) * 100 / minutes;

    const mid = recent[Math.floor(recent.length / 2)];
    if (mid.priceUsd && mid !== oldest) {
      const firstHalf = ((mid.priceUsd - oldest.priceUsd!) / oldest.priceUsd!) * 100;
      const secondHalf = ((m.priceUsd - mid.priceUsd) / mid.priceUsd) * 100;
      m.momentumAcceleration = secondHalf - firstHalf;
    }
  }

  // Volatility: stdev of consecutive returns, %
  const prices = arr.map((s) => s.priceUsd).filter((p): p is number => p !== null);
  if (prices.length >= 4) {
    const returns = prices.slice(1).map((p, i) => ((p - prices[i]) / prices[i]) * 100);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    m.volatility5m = Math.sqrt(
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length
    );
  }

  // Crude slippage estimate from constant-product depth
  if (m.liquiditySol !== null && m.liquiditySol > 0) {
    m.estSlippagePctFor1Sol = (1 / (m.liquiditySol / 2)) * 100;
  }

  // Artificial volume heuristic: huge volume with almost no participants
  if (m.volume5mUsd !== null && m.txPerMinute !== null && m.holderCount !== null) {
    m.artificialVolumeSuspected =
      m.volume5mUsd > 30_000 && m.holderCount < 50 && m.txPerMinute > 40;
    m.washTradingSuspected =
      m.buySellRatio !== null &&
      m.buySellRatio > 0.9 &&
      m.buySellRatio < 1.1 &&
      m.volume5mUsd > 20_000 &&
      m.holderCount < 80;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function emptyMetrics(mint: string, migratedAt: Date): TokenMetrics {
  return {
    mint,
    symbol: null,
    name: null,
    poolAddress: null,
    migratedAt,
    priceUsd: null,
    liquiditySol: null,
    liquidityUsd: null,
    marketCapUsd: null,
    volume5mUsd: null,
    volume1hUsd: null,
    volumeGrowthPct: null,
    priceChange5mPct: null,
    priceChange1hPct: null,
    txPerMinute: null,
    buys5m: null,
    sells5m: null,
    buySellRatio: null,
    holderCount: null,
    holderGrowth5m: null,
    topHolderPct: null,
    top10HolderPct: null,
    devWalletPct: null,
    freshWalletPct: null,
    sniperWalletCount: null,
    bundledWalletCount: null,
    liquidityChangePct: null,
    estSlippagePctFor1Sol: null,
    volatility5m: null,
    momentum: null,
    momentumAcceleration: null,
    mintAuthorityRevoked: null,
    freezeAuthorityRevoked: null,
    lpBurnedOrLockedPct: null,
    isHoneypotSuspected: null,
    devSoldPct: null,
    washTradingSuspected: null,
    artificialVolumeSuspected: null,
    devReputationScore: null,
    ageSinceMigrationSec: Math.floor((Date.now() - migratedAt.getTime()) / 1000),
    missingSources: [],
  };
}

export async function collectMetrics(
  conn: Connection,
  mint: string,
  migratedAt: Date
): Promise<TokenMetrics> {
  const m = emptyMetrics(mint, migratedAt);

  const results = await Promise.allSettled([
    collectDexScreener(mint, m),
    collectOnChain(conn, mint, m),
    collectHelius(mint, m),
  ]);
  const names = ["dexscreener", "rpc", "helius"];
  results.forEach((r, i) => {
    if (r.status === "rejected") m.missingSources.push(names[i]);
  });

  deriveFromHistory(mint, m);
  rememberSnapshot(mint, {
    at: Date.now(),
    priceUsd: m.priceUsd,
    liquidityUsd: m.liquidityUsd,
    volume5mUsd: m.volume5mUsd,
    holderCount: m.holderCount,
  });

  m.ageSinceMigrationSec = Math.floor((Date.now() - migratedAt.getTime()) / 1000);
  return m;
}
