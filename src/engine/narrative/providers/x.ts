/**
 * X (Twitter) mention counts — OPTIONAL. Requires TWITTER_BEARER_TOKEN with
 * access to the v2 recent tweet-counts endpoint. Without a token (or when
 * the token's tier lacks access) this provider reports null and the
 * aggregator scores X data as unavailable — never as a negative.
 */

let unavailableLoggedAt = 0;

export async function collectXMentions(symbol: string | null): Promise<number | null> {
  const token = process.env.TWITTER_BEARER_TOKEN?.trim();
  if (!token || !symbol) return null;
  try {
    const query = encodeURIComponent(`("$${symbol}" OR "#${symbol}") -is:retweet`);
    const res = await fetch(
      `https://api.twitter.com/2/tweets/counts/recent?query=${query}&granularity=day`,
      {
        signal: AbortSignal.timeout(6000),
        headers: { authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) {
      // 402/403 = token tier lacks counts access; log once an hour, not per token
      if (Date.now() - unavailableLoggedAt > 3_600_000) {
        unavailableLoggedAt = Date.now();
        console.warn(`[narrative] X API unavailable (HTTP ${res.status}) — continuing without X data`);
      }
      return null;
    }
    const body = (await res.json()) as { meta?: { total_tweet_count?: number } };
    return body.meta?.total_tweet_count ?? null;
  } catch {
    return null;
  }
}
