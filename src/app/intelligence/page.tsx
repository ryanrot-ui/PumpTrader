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
