import { prisma } from "@/lib/prisma";
import { logger } from "../logging/logger";
import { getPairSnapshot } from "../analysis/collectors";

/**
 * Missed-opportunity tracker: the bot learns from every token it REFUSED,
 * not only from trades it took.
 *
 * Recording: every hard rejection (and every watch-window expiry) stores
 * the score, full rejection reasons, the hard gates that failed, and the
 * market context at that moment.
 *
 * Monitoring: a 5-minute loop follows each tracked token for 24h, keeping
 * running high/low/max-gain/max-loss vs the rejection price, freezing a
 * snapshot at each checkpoint (5m/15m/30m/1h/4h/24h), and flagging rugs
 * (liquidity gone or price -80%+).
 *
 * Grading: filterEffectiveness() answers, per hard gate: how many
 * rejections, how many later rugged/died (saved), how many became real
 * winners (missed), and the resulting accuracy — evidence for loosening
 * filters that cost profit and keeping ones that save capital.
 */

const CHECKPOINTS: Array<{ label: string; ms: number }> = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 3_600_000 },
  { label: "4h", ms: 4 * 3_600_000 },
  { label: "24h", ms: 24 * 3_600_000 },
];
const MAX_ACTIVE = 400; // bound DexScreener load + table growth
const BATCH_PER_TICK = 40;
export const WINNER_GAIN_PCT = 50; // "missed winner" = ≥ +50% within 24h, no rug
const RUG_PRICE_FRACTION = 0.2; // price ≤ 20% of rejection price
const RUG_LIQUIDITY_USD = 1_000;

export interface MissedRecordInput {
  mint: string;
  tokenId: string;
  symbol: string | null;
  verdict: "REJECTED" | "IGNORED";
  score: number | null;
  rejectionReasons: string[];
  hardFailRules: string[];
  priceUsd: number | null;
  entryContext: Record<string, unknown>;
}

/** Record a rejection for outcome tracking (dedupe by mint, capped). */
export async function recordMissedOpportunity(input: MissedRecordInput): Promise<void> {
  try {
    if (input.priceUsd == null) return; // no baseline price → outcome unmeasurable
    const active = await prisma.missedOpportunity.count({ where: { doneAt: null } });
    if (active >= MAX_ACTIVE) return;
    await prisma.missedOpportunity
      .create({
        data: {
          mint: input.mint,
          tokenId: input.tokenId,
          symbol: input.symbol,
          verdict: input.verdict,
          score: input.score,
          rejectionReasons: input.rejectionReasons.slice(0, 10),
          hardFailRules: input.hardFailRules,
          priceAtRejection: input.priceUsd,
          highestPriceUsd: input.priceUsd,
          lowestPriceUsd: input.priceUsd,
          maxGainPct: 0,
          maxLossPct: 0,
          entryContext: JSON.parse(JSON.stringify(input.entryContext)),
        },
      })
      .catch(() => {}); // unique(mint) → already tracked
  } catch {
    /* tracking must never disturb trading */
  }
}

/** One monitoring tick: refresh a batch of open trackers. */
export async function monitorMissedOpportunities(): Promise<void> {
  const open = await prisma.missedOpportunity.findMany({
    where: { doneAt: null },
    orderBy: { rejectedAt: "asc" },
    take: BATCH_PER_TICK,
  });
  for (const m of open) {
    const ageMs = Date.now() - m.rejectedAt.getTime();
    const snap = await getPairSnapshot(m.mint);
    const price = snap?.priceUsd ?? null;
    const base = m.priceAtRejection ?? 0;

    let highest = m.highestPriceUsd ?? base;
    let lowest = m.lowestPriceUsd ?? base;
    let rugged = m.rugged ?? false;
    if (price != null && base > 0) {
      highest = Math.max(highest, price);
      lowest = Math.min(lowest, price);
      if (price <= base * RUG_PRICE_FRACTION || (snap?.liquidityUsd ?? Infinity) < RUG_LIQUIDITY_USD) {
        rugged = true;
      }
    } else if (snap === null && ageMs > 3_600_000) {
      // pair no longer indexed an hour+ in → treat as dead/rugged
      rugged = true;
    }
    const maxGainPct = base > 0 ? ((highest - base) / base) * 100 : 0;
    const maxLossPct = base > 0 ? ((lowest - base) / base) * 100 : 0;

    // freeze any checkpoint we've crossed since the last tick
    const checkpoints = (m.checkpoints ?? {}) as Record<string, unknown>;
    for (const cp of CHECKPOINTS) {
      if (ageMs >= cp.ms && !(cp.label in checkpoints)) {
        checkpoints[cp.label] = {
          high: highest,
          low: lowest,
          maxGainPct: Math.round(maxGainPct * 10) / 10,
          maxLossPct: Math.round(maxLossPct * 10) / 10,
          rugged,
        };
      }
    }
    const done = ageMs >= CHECKPOINTS[CHECKPOINTS.length - 1].ms;

    await prisma.missedOpportunity
      .update({
        where: { id: m.id },
        data: {
          highestPriceUsd: highest,
          lowestPriceUsd: lowest,
          maxGainPct,
          maxLossPct,
          rugged,
          checkpoints: JSON.parse(JSON.stringify(checkpoints)),
          ...(done ? { doneAt: new Date() } : {}),
        },
      })
      .catch(() => {});
    if (done && maxGainPct >= WINNER_GAIN_PCT && !rugged) {
      logger.info(
        "scoring",
        `missed opportunity: ${m.symbol ?? m.mint.slice(0, 8)}… peaked +${maxGainPct.toFixed(0)}% within 24h of rejection (${m.hardFailRules.join(", ") || "score below threshold"})`
      );
    }
  }
}

// ── Phase 2: filter effectiveness ────────────────────────────────────────────

export interface FilterEffectiveness {
  rule: string;
  rejected: number;
  saved: number; // rugged or never went anywhere
  missedWinners: number; // ≥ +50% within 24h without rugging
  accuracyPct: number; // saved / rejected
  missedPnlPct: number; // sum of missed winners' max gains (opportunity cost)
}

export function computeFilterEffectiveness(
  rows: Array<{ hardFailRules: string[]; maxGainPct: number | null; rugged: boolean | null }>
): FilterEffectiveness[] {
  const map = new Map<string, { rejected: number; saved: number; missed: number; missedPnl: number }>();
  for (const r of rows) {
    const isWinner = (r.maxGainPct ?? 0) >= WINNER_GAIN_PCT && r.rugged !== true;
    const rules = r.hardFailRules.length ? r.hardFailRules : ["score below threshold"];
    for (const rule of rules) {
      const cur = map.get(rule) ?? { rejected: 0, saved: 0, missed: 0, missedPnl: 0 };
      cur.rejected++;
      if (isWinner) {
        cur.missed++;
        cur.missedPnl += r.maxGainPct ?? 0;
      } else {
        cur.saved++;
      }
      map.set(rule, cur);
    }
  }
  return [...map.entries()]
    .map(([rule, v]) => ({
      rule,
      rejected: v.rejected,
      saved: v.saved,
      missedWinners: v.missed,
      accuracyPct: v.rejected ? (v.saved / v.rejected) * 100 : 0,
      missedPnlPct: v.missedPnl,
    }))
    .sort((a, b) => b.rejected - a.rejected);
}
