import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Trending Solana tokens, sourced from DexScreener's public boosts endpoint
 * (the tokens paying for visibility right now — the closest public proxy for
 * "what the market is looking at"). Server-side fetch (same-origin CSP stays
 * intact), cached for 60s so the dashboard poll never hits DexScreener's
 * rate limits.
 *
 * NOTE: a paid boost is *attention*, not quality — the dashboard labels it.
 * This list is informational only; it feeds no buy decision.
 */

const BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1";
const PAIRS_URL = "https://api.dexscreener.com/tokens/v1/solana";
const CACHE_MS = 60_000;
const MAX_TOKENS = 12;

interface TrendingToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  boostAmount: number | null;
  url: string;
}

let cache: { at: number; tokens: TrendingToken[] } | null = null;

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.tokens);
  }

  try {
    const boostsRes = await fetch(BOOSTS_URL, { signal: AbortSignal.timeout(8000) });
    if (!boostsRes.ok) throw new Error(`boosts HTTP ${boostsRes.status}`);
    const boosts = (await boostsRes.json()) as Array<{
      chainId: string;
      tokenAddress: string;
      totalAmount?: number;
      amount?: number;
    }>;
    const solana = boosts.filter((b) => b.chainId === "solana").slice(0, MAX_TOKENS);
    if (solana.length === 0) {
      cache = { at: Date.now(), tokens: [] };
      return NextResponse.json([]);
    }

    // One batch call for market data on all boosted mints (API allows up to 30).
    const addrs = solana.map((b) => b.tokenAddress).join(",");
    const pairsRes = await fetch(`${PAIRS_URL}/${addrs}`, { signal: AbortSignal.timeout(8000) });
    const pairs = pairsRes.ok
      ? ((await pairsRes.json()) as Array<{
          baseToken?: { address?: string; symbol?: string; name?: string };
          priceUsd?: string;
          marketCap?: number;
          priceChange?: { h24?: number };
          volume?: { h24?: number };
          liquidity?: { usd?: number };
        }>)
      : [];

    const byMint = new Map<string, (typeof pairs)[number]>();
    for (const p of pairs) {
      const addr = p.baseToken?.address;
      if (!addr) continue;
      // keep the most liquid pair per token
      const prev = byMint.get(addr);
      if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) byMint.set(addr, p);
    }

    const tokens: TrendingToken[] = solana.map((b) => {
      const p = byMint.get(b.tokenAddress);
      return {
        mint: b.tokenAddress,
        symbol: p?.baseToken?.symbol ?? null,
        name: p?.baseToken?.name ?? null,
        priceUsd: p?.priceUsd != null ? Number(p.priceUsd) : null,
        marketCapUsd: p?.marketCap ?? null,
        change24hPct: p?.priceChange?.h24 ?? null,
        volume24hUsd: p?.volume?.h24 ?? null,
        boostAmount: b.totalAmount ?? b.amount ?? null,
        url: `https://dexscreener.com/solana/${b.tokenAddress}`,
      };
    });

    cache = { at: Date.now(), tokens };
    return NextResponse.json(tokens);
  } catch (e) {
    console.warn("[trending] fetch failed:", (e as Error).message);
    // Serve stale data over an error — this panel is informational only.
    return NextResponse.json(cache?.tokens ?? []);
  }
}
