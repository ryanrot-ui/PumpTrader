import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";
import { dbGuard } from "@/lib/dbGuard";
import { DEFAULT_INFLUENCERS } from "@/engine/narrative/trends";

/**
 * Narrative dashboard data: top/fastest-growing trending narratives from
 * the trend tracker, influencer activity, configuration status, and recent
 * token↔narrative matches (from persisted narrative snapshots).
 */
async function handleGet() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const [narratives, recentSnapshots] = await Promise.all([
    prisma.trendingNarrative.findMany({ orderBy: { mentions: "desc" }, take: 100 }),
    prisma.narrativeSnapshot.findMany({
      orderBy: { at: "desc" },
      take: 300,
      select: { at: true, report: true, narrativeScore: true, token: { select: { mint: true, symbol: true, name: true } } },
    }),
  ]);

  // recent token↔narrative matches, deduped per mint (latest wins)
  const seen = new Set<string>();
  const matches: Array<{
    at: Date;
    mint: string;
    symbol: string | null;
    narrative: string;
    matchPct: number;
    scoreDelta: number;
    peaked: boolean;
    detail: string;
  }> = [];
  for (const s of recentSnapshots) {
    const mint = s.token?.mint;
    if (!mint || seen.has(mint)) continue;
    const tm = (s.report as { trendMatch?: { narrative: string; matchPct: number; scoreDelta: number; peaked: boolean; detail: string } } | null)
      ?.trendMatch;
    if (!tm) continue;
    seen.add(mint);
    matches.push({ at: s.at, mint, symbol: s.token?.symbol ?? null, ...tm });
    if (matches.length >= 20) break;
  }

  // influencer activity: how many active narratives each handle contributed to
  const influencerActivity = new Map<string, number>();
  for (const n of narratives) {
    for (const h of n.influencers) influencerActivity.set(h, (influencerActivity.get(h) ?? 0) + 1);
  }

  const xConfigured = !!process.env.TWITTER_BEARER_TOKEN?.trim();
  const watchlist = (process.env.X_INFLUENCER_HANDLES ?? DEFAULT_INFLUENCERS.join(","))
    .split(",")
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);

  return NextResponse.json({
    config: {
      xConfigured,
      watchlist,
      sources: ["reddit (free)", "dexscreener boosts (free)", xConfigured ? "x influencer watchlist" : "x (set TWITTER_BEARER_TOKEN to enable)"],
    },
    top: narratives.slice(0, 25).map((n) => ({
      term: n.display,
      mentions: n.mentions,
      totalMentions: n.totalMentions,
      engagement: n.engagement,
      growthPct: n.growthPct,
      peaked: n.peaked,
      sources: n.sources,
      influencers: n.influencers,
      firstSeenAt: n.firstSeenAt,
      lastSeenAt: n.lastSeenAt,
    })),
    fastestGrowing: [...narratives]
      .filter((n) => !n.peaked && (n.growthPct ?? 0) > 0 && n.mentions >= 2)
      .sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0))
      .slice(0, 10)
      .map((n) => ({ term: n.display, mentions: n.mentions, growthPct: n.growthPct, sources: n.sources })),
    influencerActivity: [...influencerActivity.entries()]
      .map(([handle, count]) => ({ handle, narratives: count }))
      .sort((a, b) => b.narratives - a.narratives),
    recentMatches: matches,
  });
}

export const GET = dbGuard(handleGet);
