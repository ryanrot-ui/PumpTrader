"use client";

import { useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { shortMint, timeAgo } from "@/components/ui";

/**
 * AI trade journal: what the bot has learned from every completed trade —
 * cause attribution, lessons with win rates, significance-gated
 * recommendations (backtested before they can be applied), and the full
 * revertible parameter-change history.
 */

interface Lesson {
  tag: string;
  trades: number;
  winRate: number;
  pnlSol: number;
}

interface CauseAgg {
  cause: string;
  count: number;
  weightedCount: number;
}

interface Review {
  id: string;
  at: string;
  mint: string;
  symbol: string | null;
  win: boolean;
  pnlPct: number | null;
  exitKind: string;
  causes: Array<{ cause: string; confidencePct: number; detail: string }>;
  tags: string[];
}

interface Recommendation {
  parameter: string;
  label: string;
  current: number | boolean | null;
  proposed: number | boolean;
  direction: string;
  evidence: {
    relevantTrades: number;
    keptTrades: number;
    filteredTrades: number;
    keptWinRate: number;
    filteredWinRate: number;
    expectedWinRateDeltaPct: number;
    filteredPnlSol: number;
    confidencePct: number;
  };
  summary: string;
}

interface ParameterChangeRow {
  id: string;
  at: string;
  source: string;
  changedKeys: string[];
  note: string | null;
}

interface LearningData {
  reviewsStored: number;
  minRelevantTrades: number;
  lessons: Lesson[];
  topLossCauses: CauseAgg[];
  topWinCauses: CauseAgg[];
  recentReviews: Review[];
  patterns: {
    tradesAnalyzed: number;
    findings: Array<{ characteristic: string; group: string; detail: string }>;
    recommendations: Recommendation[];
    strategyConfidence: number;
    strategyConfidenceDetail: string;
  };
  parameterChanges: ParameterChangeRow[];
  winRateSeries: Array<{ trade: number; winRate: number; at: string }>;
}

type StatsMode = "all" | "paper" | "live";

export default function LearningPage() {
  const [mode, setMode] = useState<StatsMode>("all");
  const { data, reload } = usePoll<LearningData>(`/api/learning?mode=${mode}`, 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const post = async (payload: Record<string, unknown>, busyKey: string) => {
    setBusy(busyKey);
    setMessage(null);
    const res = await fetch("/api/learning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as {
      applied?: boolean;
      reverted?: boolean;
      error?: string;
      comparison?: { verdict?: string } | null;
    };
    if (res?.ok && (body.applied || body.reverted)) {
      setMessage(
        body.applied
          ? `✓ Applied — ${body.comparison?.verdict ?? "engine reloading"}`
          : "✓ Reverted — engine reloading"
      );
    } else {
      setMessage(body.error ?? "Request failed");
    }
    setBusy(null);
    reload();
  };

  const p = data?.patterns;

  return (
    <AppShell>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h1 className="text-xl font-semibold">Learning</h1>
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
              {m === "all" ? "All trades" : m === "paper" ? "Paper" : "Live"}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4 max-w-3xl">
        Every completed trade is reviewed automatically: why it won or lost, which conditions it
        traded under, and what the accumulated record says. Nothing here changes the strategy on
        its own — recommendations require {data?.minRelevantTrades ?? 50}+ relevant trades,
        statistical significance, and a passing backtest before they can be applied.
      </p>

      {!data && <p className="text-sm text-slate-600">Loading…</p>}

      {data && p && (
        <>
          {/* Strategy confidence + win rate over time */}
          <div className="grid lg:grid-cols-3 gap-4 mb-4">
            <div className="card">
              <div className="stat-label mb-2">Confidence in current strategy</div>
              <div className={`text-3xl font-semibold ${p.strategyConfidence >= 60 ? "text-profit" : p.strategyConfidence >= 35 ? "text-warn" : "text-loss"}`}>
                {p.strategyConfidence}/100
              </div>
              <p className="text-[11px] text-slate-500 mt-2">{p.strategyConfidenceDetail}</p>
              <p className="text-[11px] text-slate-600 mt-1">
                {data.reviewsStored} trade reviews stored · {p.tradesAnalyzed} trades analyzed
              </p>
            </div>
            <div className="card lg:col-span-2">
              <div className="stat-label mb-2">Win rate over time (rolling 20 trades)</div>
              <div className="h-36">
                {data.winRateSeries.length >= 2 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.winRateSeries} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                      <XAxis dataKey="trade" stroke="#475569" fontSize={10} />
                      <YAxis domain={[0, 100]} stroke="#475569" fontSize={10} />
                      <Tooltip
                        contentStyle={{ background: "#161b28", border: "1px solid #232a3b", borderRadius: 8 }}
                        formatter={(v) => [`${(v as number).toFixed(0)}%`, "win rate"]}
                        labelFormatter={(l) => `after trade ${l}`}
                      />
                      <Line type="monotone" dataKey="winRate" stroke="#6366f1" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-slate-600">
                    Appears after 20 closed trades.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Recommendations */}
          <div className="card mb-4">
            <div className="stat-label mb-2">Current recommendations — significance-gated, backtested before apply</div>
            {message && <p className="text-xs mb-2 text-slate-300">{message}</p>}
            {p.recommendations.length === 0 ? (
              <p className="text-sm text-slate-600">
                None right now. Recommendations appear when ≥{data.minRelevantTrades} relevant trades
                show a statistically significant edge (≥95%) for a tighter parameter — random noise
                and hot streaks don&apos;t qualify.
              </p>
            ) : (
              <div className="space-y-3">
                {p.recommendations.map((r) => (
                  <div key={r.parameter} className="border border-surface-border rounded-lg p-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="text-sm text-slate-200">
                        {r.label}: <span className="font-mono">{String(r.current ?? "—")}</span> →{" "}
                        <span className="font-mono text-accent">{String(r.proposed)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">
                          +{r.evidence.expectedWinRateDeltaPct.toFixed(1)}pp win rate · confidence {r.evidence.confidencePct}%
                        </span>
                        <button
                          disabled={busy !== null}
                          onClick={() =>
                            void post(
                              { action: "apply", changes: { [r.parameter]: r.proposed }, note: r.summary },
                              r.parameter
                            )
                          }
                          className="btn-primary text-xs px-3 py-1 disabled:opacity-50"
                          title="Backtests against the current strategy first; applies only if the replay improves"
                        >
                          {busy === r.parameter ? "Backtesting…" : "Backtest & apply"}
                        </button>
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">{r.summary}</p>
                  </div>
                ))}
              </div>
            )}
            {p.findings.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] text-slate-500 mb-1">Detected patterns (descriptive, no action taken)</div>
                {p.findings.map((f, i) => (
                  <p key={i} className="text-[11px] text-slate-500">
                    · {f.detail}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Lessons + causes */}
          <div className="grid md:grid-cols-3 gap-4 mb-4">
            <div className="card">
              <div className="stat-label mb-2">Lessons — win rate by condition</div>
              {data.lessons.length === 0 ? (
                <p className="text-sm text-slate-600">Builds up as trades complete (min 5 per condition).</p>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {data.lessons.map((l) => (
                      <tr key={l.tag} className="border-b border-surface-border/40">
                        <td className="py-1 pr-2 text-slate-300">{l.tag.replace(/_/g, " ")}</td>
                        <td className="py-1 pr-2 text-right text-slate-500">{l.trades}</td>
                        <td className={`py-1 text-right font-mono ${l.winRate >= 50 ? "text-profit" : "text-loss"}`}>
                          {l.winRate.toFixed(0)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <CauseCard title="Top reasons trades lose" causes={data.topLossCauses} tone="loss" />
            <CauseCard title="Top reasons trades win" causes={data.topWinCauses} tone="profit" />
          </div>

          {/* Recent reviews */}
          <div className="card mb-4">
            <div className="stat-label mb-2">Recent trade reviews</div>
            {data.recentReviews.length === 0 ? (
              <p className="text-sm text-slate-600">Generated automatically after every completed trade.</p>
            ) : (
              <div className="space-y-2">
                {data.recentReviews.map((r) => (
                  <div key={r.id} className="border-b border-surface-border/40 pb-2 last:border-0">
                    <div className="flex items-center justify-between flex-wrap gap-1 text-xs">
                      <span className="font-mono text-slate-300">
                        {r.symbol ?? shortMint(r.mint)}
                        <span className={`ml-2 ${r.win ? "text-profit" : "text-loss"}`}>
                          {r.win ? "WIN" : "LOSS"} {r.pnlPct != null ? `${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%` : ""}
                        </span>
                        <span className="text-slate-600 ml-2">{r.exitKind.replace(/_/g, " ")}</span>
                      </span>
                      <span className="text-slate-600">{timeAgo(new Date(r.at))} ago</span>
                    </div>
                    {r.causes.map((c, i) => (
                      <p key={i} className="text-[11px] text-slate-500 mt-0.5">
                        {i === 0 ? "Primary" : i === 1 ? "Secondary" : "Contributing"}: {c.cause} ({c.confidencePct}%) — {c.detail}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Parameter change history */}
          <div className="card">
            <div className="stat-label mb-2">Parameter changes — every change is revertible</div>
            {data.parameterChanges.length === 0 ? (
              <p className="text-sm text-slate-600">No recorded changes yet.</p>
            ) : (
              <div className="space-y-1">
                {data.parameterChanges.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 text-xs border-b border-surface-border/40 pb-1 last:border-0">
                    <div className="min-w-0">
                      <span className="text-slate-300">{c.changedKeys.join(", ")}</span>
                      <span className="text-slate-600 ml-2">
                        {c.source} · {timeAgo(new Date(c.at))} ago
                      </span>
                      {c.note && (
                        <p className="text-[10px] text-slate-600 truncate" title={c.note}>
                          {c.note}
                        </p>
                      )}
                    </div>
                    {c.source !== "revert" && (
                      <button
                        disabled={busy !== null}
                        onClick={() => void post({ action: "revert", changeId: c.id }, c.id)}
                        className="btn-ghost text-xs px-2 py-1 shrink-0 disabled:opacity-50"
                      >
                        {busy === c.id ? "Reverting…" : "Revert"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}

function CauseCard({ title, causes, tone }: { title: string; causes: CauseAgg[]; tone: "profit" | "loss" }) {
  return (
    <div className="card">
      <div className="stat-label mb-2">{title}</div>
      {causes.length === 0 ? (
        <p className="text-sm text-slate-600">Not enough completed trades yet.</p>
      ) : (
        <div className="space-y-1">
          {causes.map((c) => (
            <div key={c.cause} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-300 truncate">{c.cause}</span>
              <span className={`shrink-0 ${tone === "profit" ? "text-profit" : "text-loss"}`}>×{c.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
