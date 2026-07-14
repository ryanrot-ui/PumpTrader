"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { ScoreBadge, shortMint, timeAgo } from "@/components/ui";

interface SignalRow {
  signal: string;
  bucket: string;
  trades: number;
  wins: number;
  winRate: number | null;
  avgRoiPct: number | null;
}

interface SignalsResponse {
  mode: string;
  totalClosed: number;
  withEntrySignals: number;
  rows: SignalRow[];
}

interface TokenRow {
  mint: string;
  symbol: string | null;
  verdict: string | null;
  detectedAt: string;
  score: number | null;
  narrativeScore: number | null;
  memeScore: number | null;
  rugRiskScore: number | null;
  narrative: {
    bullishFactors?: string[];
    bearishFactors?: string[];
    meme?: string;
    narrative?: string;
    rug?: string;
    missingSources?: string[];
  } | null;
}

interface NarrativesResponse {
  config: { xConfigured: boolean; watchlist: string[]; sources: string[] };
  top: Array<{
    term: string;
    mentions: number;
    totalMentions: number;
    growthPct: number | null;
    peaked: boolean;
    sources: string[];
    influencers: string[];
    firstSeenAt: string;
  }>;
  fastestGrowing: Array<{ term: string; mentions: number; growthPct: number | null; sources: string[] }>;
  influencerActivity: Array<{ handle: string; narratives: number }>;
  recentMatches: Array<{
    at: string;
    mint: string;
    symbol: string | null;
    narrative: string;
    matchPct: number;
    scoreDelta: number;
    peaked: boolean;
    detail: string;
  }>;
}

function TrendPanel() {
  const { data } = usePoll<NarrativesResponse>("/api/narratives", 60_000);
  if (!data) return null;
  return (
    <div className="grid lg:grid-cols-3 gap-4 mb-4">
      <div className="card">
        <div className="stat-label mb-1">Top trending narratives</div>
        <p className="text-[10px] text-slate-600 mb-2">
          Sources: {data.config.sources.join(" · ")}. Trend matches only nudge the narrative score
          (bounded, peaked = penalty) — they never buy anything on their own.
        </p>
        {data.top.length === 0 ? (
          <p className="text-sm text-slate-600">Builds up as the tracker refreshes (every 10 min).</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {data.top.slice(0, 15).map((n) => (
              <div key={n.term} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-200 truncate" title={n.influencers.length ? `via ${n.influencers.join(", ")}` : undefined}>
                  {n.term}
                  {n.peaked && <span className="text-loss ml-1.5 text-[10px]">peaked</span>}
                </span>
                <span className="shrink-0 text-slate-500">
                  ×{n.mentions}
                  {n.growthPct != null && (
                    <span className={n.growthPct > 0 ? "text-profit ml-1.5" : "text-slate-600 ml-1.5"}>
                      {n.growthPct > 0 ? "+" : ""}{n.growthPct.toFixed(0)}%
                    </span>
                  )}
                  <span className="text-slate-700 ml-1.5">{n.sources.join("+")}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="stat-label mb-2">Fastest growing · influencer activity</div>
        {data.fastestGrowing.length === 0 ? (
          <p className="text-sm text-slate-600">No accelerating narratives right now.</p>
        ) : (
          <div className="space-y-1 mb-3">
            {data.fastestGrowing.map((n) => (
              <div key={n.term} className="flex items-center justify-between text-xs">
                <span className="text-slate-200 truncate">{n.term}</span>
                <span className="text-profit shrink-0">+{n.growthPct?.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        )}
        <div className="text-[10px] text-slate-500 mb-1">
          Watchlist ({data.config.xConfigured ? "X live" : "X off — set TWITTER_BEARER_TOKEN"}):
        </div>
        <p className="text-[11px] text-slate-400 break-words">
          {data.config.watchlist.map((h) => `@${h}`).join("  ")}
        </p>
        {data.influencerActivity.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {data.influencerActivity.slice(0, 6).map((a) => (
              <p key={a.handle} className="text-[11px] text-slate-500">
                @{a.handle}: {a.narratives} active narrative(s)
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="stat-label mb-2">Recent token ↔ narrative matches</div>
        {data.recentMatches.length === 0 ? (
          <p className="text-sm text-slate-600">
            Appears when a scanned token matches an active narrative (semantic match ≥70%).
          </p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {data.recentMatches.map((m) => (
              <div key={`${m.mint}-${m.at}`} className="text-xs border-b border-surface-border/40 pb-1 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-slate-200">{m.symbol ?? shortMint(m.mint)}</span>
                  <span className={m.peaked ? "text-loss" : "text-profit"}>
                    “{m.narrative}” {m.matchPct}% · {m.scoreDelta >= 0 ? "+" : ""}{m.scoreDelta}
                  </span>
                </div>
                <p className="text-[10px] text-slate-600 truncate" title={m.detail}>{m.detail}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function riskTone(v: number | null): string {
  if (v === null) return "text-slate-500";
  if (v <= 30) return "text-profit";
  if (v <= 60) return "text-warn";
  return "text-loss";
}

export default function IntelligencePage() {
  const [mode, setMode] = useState<"all" | "paper" | "live">("all");
  const { data: signals } = usePoll<SignalsResponse>(`/api/signals?mode=${mode}`, 30_000);
  const { data: tokens } = usePoll<TokenRow[]>("/api/tokens?limit=25", 15_000);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <AppShell>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h1 className="text-xl font-semibold">Narrative intelligence</h1>
        <div className="flex gap-1.5">
          {(["all", "paper", "live"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                mode === m
                  ? "bg-accent/20 border-accent/50 text-accent"
                  : "bg-surface-overlay border-surface-border text-slate-500 hover:text-slate-300"
              }`}
            >
              {m === "all" ? "All trades" : m}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4 max-w-3xl">
        Social and meme research on every scanned token, and which entry signals actually
        preceded winners in this bot&apos;s own history. Descriptive statistics — small
        samples prove nothing, and no signal here predicts profit.
      </p>

      {/* Trending narratives (trend tracker) */}
      <TrendPanel />

      {/* Signal performance (learning analytics) */}
      <div className="card mb-4">
        <div className="stat-label mb-1">Signal performance vs outcomes</div>
        <p className="text-[11px] text-slate-600 mb-3">
          {signals
            ? `${signals.withEntrySignals} of ${signals.totalClosed} closed trades carry entry signals.`
            : "Loading…"}{" "}
          Win rates compare the signals present at entry with the realized result.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-surface-border">
                <th className="pb-2 pr-4">Signal at entry</th>
                <th className="pb-2 pr-4">Bucket</th>
                <th className="pb-2 pr-4">Trades</th>
                <th className="pb-2 pr-4">Win rate</th>
                <th className="pb-2">Avg ROI</th>
              </tr>
            </thead>
            <tbody>
              {(signals?.rows ?? []).map((r) => (
                <tr key={`${r.signal}-${r.bucket}`} className="border-b border-surface-border/50">
                  <td className="py-1.5 pr-4 text-slate-300">{r.signal}</td>
                  <td className="py-1.5 pr-4 text-slate-400">{r.bucket}</td>
                  <td className="py-1.5 pr-4 font-mono">{r.trades}</td>
                  <td className="py-1.5 pr-4 font-mono">
                    {r.winRate != null ? `${r.winRate.toFixed(0)}%` : "—"}
                    <span className="text-slate-600 text-xs"> ({r.wins}W)</span>
                  </td>
                  <td
                    className={`py-1.5 font-mono ${(r.avgRoiPct ?? 0) > 0 ? "text-profit" : (r.avgRoiPct ?? 0) < 0 ? "text-loss" : ""}`}
                  >
                    {r.avgRoiPct != null ? `${r.avgRoiPct > 0 ? "+" : ""}${r.avgRoiPct.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
              {(!signals || signals.rows.length === 0) && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-600">
                    No closed trades with entry signals yet — the table fills in as the bot trades.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Latest token research */}
      <div className="card">
        <div className="stat-label mb-3">Latest token research (click a row for the full report)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-surface-border">
                <th className="pb-2 pr-4">Token</th>
                <th className="pb-2 pr-4">Tech</th>
                <th className="pb-2 pr-4">Narrative</th>
                <th className="pb-2 pr-4">Meme</th>
                <th className="pb-2 pr-4">Rug risk</th>
                <th className="pb-2 pr-4">Verdict</th>
                <th className="pb-2">Seen</th>
              </tr>
            </thead>
            <tbody>
              {(tokens ?? []).map((t) => (
                <>
                  <tr
                    key={t.mint}
                    onClick={() => setExpanded(expanded === t.mint ? null : t.mint)}
                    className="border-b border-surface-border/50 hover:bg-surface-overlay/50 cursor-pointer"
                  >
                    <td className="py-2 pr-4 font-mono">
                      {t.symbol ? `${t.symbol} · ` : ""}
                      {shortMint(t.mint)}
                    </td>
                    <td className="py-2 pr-4">
                      <ScoreBadge score={t.score} />
                    </td>
                    <td className="py-2 pr-4 font-mono">{t.narrativeScore ?? "—"}</td>
                    <td className="py-2 pr-4 font-mono">{t.memeScore ?? "—"}</td>
                    <td className={`py-2 pr-4 font-mono ${riskTone(t.rugRiskScore)}`}>
                      {t.rugRiskScore ?? "—"}
                    </td>
                    <td className="py-2 pr-4 text-xs text-slate-500">{t.verdict ?? "EVALUATING"}</td>
                    <td className="py-2 text-slate-500 text-xs">{timeAgo(t.detectedAt)} ago</td>
                  </tr>
                  {expanded === t.mint && t.narrative && (
                    <tr key={`${t.mint}-detail`} className="bg-surface-overlay/30">
                      <td colSpan={7} className="p-4 text-xs space-y-2">
                        {(t.narrative.bullishFactors?.length ?? 0) > 0 && (
                          <div>
                            <span className="text-profit">Bullish:</span>{" "}
                            <span className="text-slate-300">
                              {t.narrative.bullishFactors!.join(" · ")}
                            </span>
                          </div>
                        )}
                        {(t.narrative.bearishFactors?.length ?? 0) > 0 && (
                          <div>
                            <span className="text-loss">Bearish:</span>{" "}
                            <span className="text-slate-300">
                              {t.narrative.bearishFactors!.join(" · ")}
                            </span>
                          </div>
                        )}
                        {t.narrative.narrative && (
                          <div className="text-slate-400">{t.narrative.narrative}</div>
                        )}
                        {t.narrative.meme && <div className="text-slate-400">{t.narrative.meme}</div>}
                        {t.narrative.rug && <div className="text-slate-400">{t.narrative.rug}</div>}
                        {(t.narrative.missingSources?.length ?? 0) > 0 && (
                          <div className="text-slate-600">
                            Unavailable sources (scored neutral): {t.narrative.missingSources!.join(", ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {(!tokens || tokens.length === 0) && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-slate-600">
                    No tokens researched yet — start the engine to begin scanning.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
