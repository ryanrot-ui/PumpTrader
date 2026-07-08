import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, unauthorized } from "@/lib/session";

/**
 * Signal-performance learning analytics: compares the signals captured at
 * entry (Position.entrySignals) with each trade's eventual outcome, so
 * strategy tuning is grounded in this bot's own history instead of
 * assumptions. Descriptive statistics only — small samples prove nothing,
 * so the sample size is always reported alongside the win rate.
 */

interface EntrySignals {
  scannerScore?: number;
  narrativeScore?: number;
  memeScore?: number;
  rugRiskScore?: number;
  boosted?: boolean;
  hasTelegram?: boolean;
  redditPosts24h?: number | null;
  telegramMembers?: number | null;
}

interface BucketDef {
  signal: string;
  bucket: string;
  match: (s: EntrySignals) => boolean;
}

const scoreBuckets = (
  signal: string,
  key: "scannerScore" | "narrativeScore" | "memeScore"
): BucketDef[] => [
  { signal, bucket: "≥ 70", match: (s) => (s[key] ?? -1) >= 70 },
  { signal, bucket: "40–69", match: (s) => (s[key] ?? -1) >= 40 && (s[key] ?? 101) < 70 },
  { signal, bucket: "< 40", match: (s) => s[key] !== undefined && (s[key] as number) < 40 },
  { signal, bucket: "not recorded", match: (s) => s[key] === undefined },
];

const BUCKETS: BucketDef[] = [
  ...scoreBuckets("Technical score", "scannerScore"),
  ...scoreBuckets("Narrative score", "narrativeScore"),
  ...scoreBuckets("Meme strength", "memeScore"),
  { signal: "Rug risk", bucket: "≤ 30 (low)", match: (s) => (s.rugRiskScore ?? 101) <= 30 },
  { signal: "Rug risk", bucket: "31–60", match: (s) => (s.rugRiskScore ?? 101) > 30 && (s.rugRiskScore ?? 101) <= 60 },
  { signal: "Rug risk", bucket: "> 60 (high)", match: (s) => (s.rugRiskScore ?? -1) > 60 },
  { signal: "Paid promotion (boost)", bucket: "boosted", match: (s) => s.boosted === true },
  { signal: "Paid promotion (boost)", bucket: "not boosted", match: (s) => s.boosted === false },
  { signal: "Reddit discussion at entry", bucket: "active", match: (s) => (s.redditPosts24h ?? 0) > 0 },
  { signal: "Reddit discussion at entry", bucket: "none", match: (s) => s.redditPosts24h === 0 || s.redditPosts24h === null },
  { signal: "Telegram community", bucket: "≥ 500 members", match: (s) => (s.telegramMembers ?? 0) >= 500 },
  { signal: "Telegram community", bucket: "< 500 / unknown", match: (s) => (s.telegramMembers ?? 0) < 500 },
];

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "all";
  const paperFilter = mode === "paper" ? true : mode === "live" ? false : undefined;

  const closed = await prisma.position.findMany({
    where: { status: "CLOSED", ...(paperFilter === undefined ? {} : { paper: paperFilter }) },
    select: { entrySignals: true, pnlSol: true, pnlPct: true },
  });

  const withSignals = closed.map((p) => ({
    signals: (p.entrySignals ?? {}) as EntrySignals,
    win: (p.pnlSol ?? 0) > 0,
    pnlPct: p.pnlPct,
  }));

  const rows = BUCKETS.map(({ signal, bucket, match }) => {
    const sample = withSignals.filter((p) => match(p.signals));
    const wins = sample.filter((p) => p.win).length;
    const rois = sample.map((p) => p.pnlPct).filter((v): v is number => v != null);
    return {
      signal,
      bucket,
      trades: sample.length,
      wins,
      winRate: sample.length ? (wins / sample.length) * 100 : null,
      avgRoiPct: rois.length ? rois.reduce((a, b) => a + b, 0) / rois.length : null,
    };
  }).filter((r) => r.trades > 0);

  return NextResponse.json({
    mode,
    totalClosed: closed.length,
    withEntrySignals: withSignals.filter((p) => Object.keys(p.signals).length > 1).length,
    rows,
  });
}
