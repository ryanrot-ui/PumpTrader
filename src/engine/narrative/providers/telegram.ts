/**
 * Telegram community size — read from the public t.me channel preview page
 * (no bot token required). Member growth between snapshots is a strong
 * community-growth signal; a shrinking channel is a caution flag.
 */

/** Parse the member/subscriber count out of a t.me preview page. */
export function parseTelegramMembers(html: string): number | null {
  // Formats seen: "12 345 members", "1,234 subscribers", "987 members, 45 online"
  const match = html.match(
    /([\d][\d\s,. ]*)\s*(?:members|subscribers)/i
  );
  if (!match) return null;
  const numeric = match[1].replace(/[\s,. ]/g, "");
  const value = parseInt(numeric, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Telegram handles are alnum/underscore; anything else is discarded so a
 *  malicious DexScreener social entry can never shape the request path. */
const HANDLE_RE = /^[A-Za-z0-9_]{3,64}$/;

export async function collectTelegramMembers(handle: string | null): Promise<number | null> {
  if (!handle || !HANDLE_RE.test(handle)) return null;
  try {
    const res = await fetch(`https://t.me/${encodeURIComponent(handle)}`, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; pumptrader/1.0)" },
    });
    if (!res.ok) return null;
    return parseTelegramMembers(await res.text());
  } catch {
    return null;
  }
}
