/**
 * Reddit public search — mention counts, engagement, and a crude title
 * sentiment. Uses the unauthenticated JSON endpoint (rate-limited but free);
 * every failure degrades to nulls.
 */

export interface RedditReading {
  posts24h: number;
  postsPrior6d: number;
  engagement: number; // sum of score + comments over the last 24h posts
  sentiment: number | null; // -1..1 over post titles
}

interface RedditChild {
  data: { title?: string; score?: number; num_comments?: number; created_utc?: number };
}

const POSITIVE =
  /\b(moon|bull|bullish|pump|gem|lfg|huge|love|great|winning|early|100x|10x|send|based|king)\b/i;
const NEGATIVE =
  /\b(rug|rugged|scam|dump|bear|bearish|avoid|warning|honeypot|exit|dead|rekt|crash|fraud)\b/i;

export function scoreTitleSentiment(titles: string[]): number | null {
  if (titles.length === 0) return null;
  let score = 0;
  let signals = 0;
  for (const title of titles) {
    const pos = POSITIVE.test(title);
    const neg = NEGATIVE.test(title);
    if (pos) score += 1;
    if (neg) score -= 1;
    if (pos || neg) signals += 1;
  }
  if (signals === 0) return 0; // discussed, but neutral language
  return Math.max(-1, Math.min(1, score / signals));
}

export function parseRedditSearch(
  children: RedditChild[],
  now: number = Date.now()
): RedditReading {
  const dayAgo = now / 1000 - 86_400;
  const recent = children.filter((c) => (c.data.created_utc ?? 0) >= dayAgo);
  const older = children.filter((c) => (c.data.created_utc ?? 0) < dayAgo);
  return {
    posts24h: recent.length,
    postsPrior6d: older.length,
    engagement: recent.reduce(
      (a, c) => a + (c.data.score ?? 0) + (c.data.num_comments ?? 0),
      0
    ),
    sentiment: scoreTitleSentiment(recent.map((c) => c.data.title ?? "")),
  };
}

export async function collectReddit(
  symbol: string | null,
  name: string | null
): Promise<RedditReading | null> {
  const query = [symbol ? `"$${symbol}"` : null, name && name !== symbol ? `"${name}"` : null]
    .filter(Boolean)
    .join(" OR ");
  if (!query) return null;
  try {
    const url =
      `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}` +
      `&sort=new&limit=100&t=week&raw_json=1`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "pumptrader/1.0 (narrative research)" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { children?: RedditChild[] } };
    return parseRedditSearch(body.data?.children ?? []);
  } catch {
    return null;
  }
}
