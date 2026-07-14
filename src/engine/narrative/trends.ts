import { prisma } from "@/lib/prisma";
import { logger } from "../logging/logger";

/**
 * Trend intelligence: tracks emerging narratives/memes across social
 * sources and matches new tokens against them.
 *
 * Sources (each optional; the tracker degrades gracefully):
 *  - X influencer watchlist — requires TWITTER_BEARER_TOKEN; handles are
 *    configurable via X_INFLUENCER_HANDLES (comma-separated, no @)
 *  - Reddit hot posts (public JSON, no key) from configurable subreddits
 *  - DexScreener token boosts (public, no key) — market-side confirmation
 *    of which narratives money is already chasing
 *
 * Safe-by-design: trend data NEVER buys anything on its own. It only feeds
 * a bounded adjustment into the narrative score (which is itself one gated
 * input to the trade decision), and a peaked/fading narrative is a PENALTY.
 */

export const DEFAULT_INFLUENCERS = [
  "elonmusk",
  "realDonaldTrump",
  "pumpdotfun",
  "solana",
  "blknoiz06", // Ansem
  "MustStopMurad",
  "aeyakovenko",
];

const DEFAULT_SUBREDDITS = ["CryptoCurrency", "solana", "memecoins"];

const STOPWORDS = new Set(
  "the a an and or of to in on for with is are was be at by it its this that from as not just so very will can new all out up down over under more most about after before big into we you they i my your our their has have had do does did going get got make made like when where who what why how".split(
    " "
  )
);

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

export const normalizeTerm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[$#@]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Candidate narrative terms from a text: hashtags, cashtags, capitalized
 *  words, and 1–3 word phrases of non-stopwords. */
export function extractTerms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[#$]([A-Za-z][A-Za-z0-9_]{1,20})/g)) {
    out.add(normalizeTerm(m[1]));
  }
  // capitalized words mid-sentence (proper nouns / meme names)
  for (const m of text.matchAll(/(?:^|\s)([A-Z][a-zA-Z]{2,15})(?=\s|$|[.,!?])/g)) {
    const t = normalizeTerm(m[1]);
    if (!STOPWORDS.has(t) && t.length >= 3) out.add(t);
  }
  // 2-word phrases of consecutive capitalized words ("Doge Mars")
  for (const m of text.matchAll(/([A-Z][a-zA-Z]{2,12}\s+[A-Z][a-zA-Z]{2,12})/g)) {
    const t = normalizeTerm(m[1]);
    if (t.split(" ").every((w) => !STOPWORDS.has(w))) out.add(t);
  }
  // ALL-CAPS shouting ("PEANUT", "DOGE TO MARS")
  for (const m of text.matchAll(/\b([A-Z]{3,15}(?:\s+[A-Z]{2,15}){0,2})\b/g)) {
    const t = normalizeTerm(m[1]);
    const words = t.split(" ").filter((w) => !STOPWORDS.has(w));
    if (words.length > 0 && words.join("").length >= 3) out.add(words.join(" "));
  }
  return [...out].filter((t) => t.length >= 3 && t.length <= 40);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[a.length][b.length];
}

export interface NarrativeLite {
  term: string;
  display: string;
  mentions: number;
  growthPct: number | null;
  peaked: boolean;
  influencers: string[];
  sources: string[];
}

export interface TrendMatch {
  narrative: string;
  matchPct: number; // 0–100 semantic-ish similarity
  trendGrowthPct: number | null;
  peaked: boolean;
  influencers: string[];
  sources: string[];
}

/**
 * Match a token's name/symbol against active narratives. Similarity is
 * fuzzy, not exact-keyword: word containment (DOGEMARS ⊃ doge+mars), edit
 * distance on the compact forms, and substring containment all count.
 */
export function matchTokenToNarratives(
  name: string | null,
  symbol: string | null,
  narratives: NarrativeLite[]
): TrendMatch | null {
  const tokenForms = [name, symbol]
    .filter((s): s is string => !!s)
    .map(normalizeTerm)
    .filter((s) => s.length >= 3);
  if (tokenForms.length === 0 || narratives.length === 0) return null;

  let best: { n: NarrativeLite; pct: number } | null = null;
  for (const n of narratives) {
    const termCompact = n.term.replace(/ /g, "");
    const termWords = n.term.split(" ").filter((w) => !STOPWORDS.has(w));
    let pct = 0;
    for (const form of tokenForms) {
      const compact = form.replace(/ /g, "");
      if (compact === termCompact) pct = Math.max(pct, 97);
      else if (compact.includes(termCompact) || termCompact.includes(compact)) {
        const ratio = Math.min(compact.length, termCompact.length) / Math.max(compact.length, termCompact.length);
        pct = Math.max(pct, Math.round(75 + 18 * ratio));
      } else if (termWords.length > 1 && termWords.every((w) => compact.includes(w))) {
        pct = Math.max(pct, 90); // "doge to mars" → DOGEMARS
      } else {
        const d = levenshtein(compact, termCompact);
        const sim = 1 - d / Math.max(compact.length, termCompact.length);
        if (sim >= 0.75) pct = Math.max(pct, Math.round(sim * 90));
      }
    }
    if (pct >= 70 && (!best || pct > best.pct || (pct === best.pct && n.mentions > best.n.mentions))) {
      best = { n, pct };
    }
  }
  if (!best) return null;
  return {
    narrative: best.n.display,
    matchPct: best.pct,
    trendGrowthPct: best.n.growthPct,
    peaked: best.n.peaked,
    influencers: best.n.influencers,
    sources: best.n.sources,
  };
}

/**
 * Bounded narrative-score adjustment from a trend match. Growth is rewarded,
 * saturation/peaking is penalized — the goal is catching narratives BEFORE
 * they are saturated, never chasing ones that already peaked.
 */
export function trendScoreAdjustment(match: TrendMatch | null): { delta: number; detail: string } {
  if (!match) return { delta: 0, detail: "no active narrative match" };
  const strength = match.matchPct / 100;
  if (match.peaked) {
    return {
      delta: Math.round(-10 * strength),
      detail: `matches "${match.narrative}" (${match.matchPct}%) but the trend already peaked — penalty`,
    };
  }
  const growth = match.trendGrowthPct ?? 0;
  const growthFactor = growth >= 100 ? 1 : growth >= 30 ? 0.75 : growth > 0 ? 0.5 : 0.25;
  const multiSource = match.sources.length >= 2 ? 1.15 : 1;
  const delta = Math.round(15 * strength * growthFactor * multiSource);
  return {
    delta,
    detail:
      `matches "${match.narrative}" (${match.matchPct}%), trend ${growth > 0 ? `growing +${growth.toFixed(0)}%` : "flat"}` +
      (match.influencers.length ? `, via ${match.influencers.slice(0, 3).join(", ")}` : "") +
      (match.sources.length >= 2 ? `, cross-platform (${match.sources.join("+")})` : ""),
  };
}

// ── source collectors ────────────────────────────────────────────────────────

interface Mention {
  term: string;
  display: string;
  engagement: number;
  source: "x" | "reddit" | "dexscreener";
  influencer?: string;
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json", "user-agent": "PumpTrader/1.0", ...headers },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function collectXInfluencers(handles: string[]): Promise<Mention[]> {
  const token = process.env.TWITTER_BEARER_TOKEN?.trim();
  if (!token) return [];
  const out: Mention[] = [];
  for (const handle of handles.slice(0, 10)) {
    const user = await fetchJson<{ data?: { id: string } }>(
      `https://api.twitter.com/2/users/by/username/${handle}`,
      { authorization: `Bearer ${token}` }
    );
    const id = user?.data?.id;
    if (!id) continue;
    const tweets = await fetchJson<{
      data?: Array<{ text: string; public_metrics?: { like_count?: number; retweet_count?: number } }>;
    }>(
      `https://api.twitter.com/2/users/${id}/tweets?max_results=10&exclude=retweets,replies&tweet.fields=public_metrics`,
      { authorization: `Bearer ${token}` }
    );
    for (const t of tweets?.data ?? []) {
      const engagement = (t.public_metrics?.like_count ?? 0) + (t.public_metrics?.retweet_count ?? 0) * 2;
      for (const term of extractTerms(t.text)) {
        out.push({ term, display: term, engagement, source: "x", influencer: handle });
      }
    }
  }
  return out;
}

async function collectRedditHot(): Promise<Mention[]> {
  const subs = (process.env.NARRATIVE_SUBREDDITS ?? DEFAULT_SUBREDDITS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Mention[] = [];
  for (const sub of subs.slice(0, 5)) {
    const json = await fetchJson<{
      data?: { children?: Array<{ data?: { title?: string; score?: number; num_comments?: number } }> };
    }>(`https://www.reddit.com/r/${sub}/hot.json?limit=25`);
    for (const c of json?.data?.children ?? []) {
      const title = c.data?.title ?? "";
      const engagement = (c.data?.score ?? 0) + (c.data?.num_comments ?? 0);
      for (const term of extractTerms(title)) {
        out.push({ term, display: term, engagement, source: "reddit" });
      }
    }
  }
  return out;
}

async function collectDexBoosts(): Promise<Mention[]> {
  const json = await fetchJson<Array<{ tokenAddress?: string; description?: string; chainId?: string }>>(
    "https://api.dexscreener.com/token-boosts/latest/v1"
  );
  const out: Mention[] = [];
  for (const b of (json ?? []).slice(0, 60)) {
    if (b.chainId && b.chainId !== "solana") continue;
    for (const term of extractTerms(b.description ?? "")) {
      out.push({ term, display: term, engagement: 1, source: "dexscreener" });
    }
  }
  return out;
}

// ── tracker ──────────────────────────────────────────────────────────────────

const MAX_NARRATIVES = 300;
const EXPIRE_AFTER_MS = 48 * 3_600_000;

export class TrendTracker {
  private cache: NarrativeLite[] = [];

  get narratives(): NarrativeLite[] {
    return this.cache;
  }

  influencerHandles(): string[] {
    return (process.env.X_INFLUENCER_HANDLES ?? DEFAULT_INFLUENCERS.join(","))
      .split(",")
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);
  }

  /** One refresh cycle: collect → aggregate → update growth/peak state. */
  async refresh(): Promise<void> {
    const [x, reddit, dex] = await Promise.all([
      collectXInfluencers(this.influencerHandles()).catch(() => [] as Mention[]),
      collectRedditHot().catch(() => [] as Mention[]),
      collectDexBoosts().catch(() => [] as Mention[]),
    ]);
    const mentions = [...x, ...reddit, ...dex];

    // aggregate this window per normalized term
    const window = new Map<string, { display: string; count: number; engagement: number; sources: Set<string>; influencers: Set<string> }>();
    for (const m of mentions) {
      const cur = window.get(m.term) ?? {
        display: m.display,
        count: 0,
        engagement: 0,
        sources: new Set<string>(),
        influencers: new Set<string>(),
      };
      cur.count++;
      cur.engagement += m.engagement;
      cur.sources.add(m.source);
      if (m.influencer) cur.influencers.add(m.influencer);
      window.set(m.term, cur);
    }

    const now = new Date();
    for (const [term, w] of window) {
      const existing = await prisma.trendingNarrative.findUnique({ where: { term } }).catch(() => null);
      if (existing) {
        const shrinking = w.count < existing.mentions;
        const declineStreak = shrinking ? existing.declineStreak + 1 : 0;
        await prisma.trendingNarrative
          .update({
            where: { term },
            data: {
              lastSeenAt: now,
              prevMentions: existing.mentions,
              mentions: w.count,
              totalMentions: existing.totalMentions + w.count,
              engagement: existing.engagement + w.engagement,
              growthPct: existing.mentions > 0 ? ((w.count - existing.mentions) / existing.mentions) * 100 : null,
              declineStreak,
              peaked: declineStreak >= 2,
              sources: [...new Set([...existing.sources, ...w.sources])],
              influencers: [...new Set([...existing.influencers, ...w.influencers])],
            },
          })
          .catch(() => {});
      } else {
        await prisma.trendingNarrative
          .create({
            data: {
              term,
              display: w.display,
              mentions: w.count,
              totalMentions: w.count,
              engagement: w.engagement,
              sources: [...w.sources],
              influencers: [...w.influencers],
            },
          })
          .catch(() => {});
      }
    }

    // expire stale narratives + bound the table
    await prisma.trendingNarrative
      .deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - EXPIRE_AFTER_MS) } } })
      .catch(() => {});
    const rows = await prisma.trendingNarrative.findMany({
      orderBy: [{ mentions: "desc" }],
      take: MAX_NARRATIVES,
    });
    this.cache = rows.map((r) => ({
      term: r.term,
      display: r.display,
      mentions: r.mentions,
      growthPct: r.growthPct,
      peaked: r.peaked,
      influencers: r.influencers,
      sources: r.sources,
    }));
    logger.debug(
      "scoring",
      `narrative trends refreshed: ${window.size} terms this window, ${this.cache.length} active (x:${x.length > 0 ? "on" : "off"}, reddit:${reddit.length}, dex:${dex.length})`
    );
  }
}
