import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 200);

  const tokens = await prisma.detectedToken.findMany({
    orderBy: { detectedAt: "desc" },
    take: limit,
    include: {
      scores: { orderBy: { at: "desc" }, take: 1 },
      snapshots: { orderBy: { at: "desc" }, take: 1 },
      narrative: { orderBy: { at: "desc" }, take: 1 },
    },
  });

  if (process.env.SCANNER_DEBUG === "1") {
    const total = await prisma.detectedToken.count().catch(() => -1);
    console.log(`[scanner-debug] /api/tokens: returning ${tokens.length} of ${total} rows (limit ${limit})`);
  }

  return NextResponse.json(
    tokens.map((t) => ({
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      imageUrl: t.imageUrl,
      websiteUrl: t.websiteUrl,
      twitterUrl: t.twitterUrl,
      telegramUrl: t.telegramUrl,
      migratedAt: t.migratedAt,
      detectedAt: t.detectedAt,
      verdict: t.verdict,
      rejectionReasons: t.rejectionReasons,
      score: t.scores[0]?.total ?? t.score ?? null,
      greenFlags: t.scores[0]?.greenFlags ?? [],
      redFlags: t.scores[0]?.redFlags ?? [],
      critical: t.scores[0]?.critical ?? false,
      breakdown: t.scores[0]?.breakdown ?? null,
      snapshot: t.snapshots[0] ?? null,
      narrativeScore: t.narrativeScore,
      memeScore: t.memeScore,
      rugRiskScore: t.rugRiskScore,
      narrative: t.narrative[0]?.report ?? null,
    }))
  );
}
