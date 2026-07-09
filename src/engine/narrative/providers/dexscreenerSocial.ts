/**
 * DexScreener social/attention signals — the always-available baseline
 * provider (no API key). Reads the token's social links, paid "boost"
 * status, and windowed txn/volume data to derive attention acceleration.
 */

const DEXSCREENER = "https://api.dexscreener.com";

interface DexPairFull {
  dexId: string;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  boosts?: { active?: number };
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ type?: string; platform?: string; url?: string; handle?: string }>;
  };
  baseToken?: { name?: string; symbol?: string };
}

export interface DexSocialReading {
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  telegramHandle: string | null;
  boostsActive: number | null;
  txnAcceleration: number | null;
  volumeAcceleration: number | null;
  tokenName: string | null;
}

export async function collectDexSocial(mint: string): Promise<DexSocialReading | null> {
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pairs: DexPairFull[] | null };
    const pair = (data.pairs ?? [])
      .filter((p) => p.dexId === "raydium")
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!pair) return null;

    const socials = pair.info?.socials ?? [];
    const socialType = (s: { type?: string; platform?: string }) =>
      (s.type ?? s.platform ?? "").toLowerCase();
    const telegram = socials.find((s) => socialType(s) === "telegram");
    const telegramHandle = telegram?.url
      ? (telegram.url.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]+)/)?.[1] ?? null)
      : (telegram?.handle ?? null);

    // Attention acceleration: recent activity rate vs the longer-window rate.
    // >1 means the token is heating up right now; <1 means cooling off.
    const txM5 = pair.txns?.m5 ? pair.txns.m5.buys + pair.txns.m5.sells : null;
    const txH1 = pair.txns?.h1 ? pair.txns.h1.buys + pair.txns.h1.sells : null;
    const txnAcceleration =
      txM5 !== null && txH1 !== null && txH1 > 0 ? txM5 / 5 / (txH1 / 60) : null;

    const volM5 = pair.volume?.m5 ?? null;
    const volH6 = pair.volume?.h6 ?? null;
    const volumeAcceleration =
      volM5 !== null && volH6 !== null && volH6 > 0 ? volM5 / 5 / (volH6 / 360) : null;

    return {
      hasTwitter: socials.some((s) => ["twitter", "x"].includes(socialType(s))),
      hasTelegram: Boolean(telegram),
      hasWebsite: (pair.info?.websites?.length ?? 0) > 0,
      telegramHandle,
      boostsActive: pair.boosts?.active ?? 0,
      txnAcceleration,
      volumeAcceleration,
      tokenName: pair.baseToken?.name ?? null,
    };
  } catch {
    return null;
  }
}
