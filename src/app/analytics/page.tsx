"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { timeAgo } from "@/components/ui";

/**
 * Strategy analytics: what the historical trades actually say — bucket
 * analyses, plain-language adjustments, the weight-optimizer's evidence
 * (with one-click apply), and the preset backtest comparison.
 */

interface BucketStat {
  label: string;
  trades: number;
  wins: number;
  winRate: number | null;
  pnlSol: number;
  avgPnlPct: number | null;
}

interface ReasonStat {
  reason: string;
  count: number;
  pnlSol: number;
}

interface MetricEvidence {
  metric: string;
  samples: number;
  winnerMean: number | null;
  loserMean: number | null;
  correlation: number | null;
  currentWeight: number;
  recommendedWeight: number;
  direction: "increase" | "decrease" | "keep";
}

interface Analytics {
  mode: string;
  stats: {
    trades: number;
    winRate: number | null;
    profitFactor: number | null;
    expectancySol: number | null;
    byMarketCap: BucketStat[];
    byLiquidity: BucketStat[];
    byTokenAge: BucketStat[];
    byHoldTime: BucketStat[];
    byScore: BucketStat[];
    byExitKind: BucketStat[];
    byHourUtc: BucketStat[];
    topWinReasons: ReasonStat[];
    topLossReasons: ReasonStat[];
  };
  adjustments: string[];
  recommendation: {
    recommended: Record<string, number>;
    evidence: MetricEvidence[];
    tradesAnalyzed: number;
    summary: string;
  } | null;
  minTradesForOptimization: number;
  reports: Array<{ id: string; at: string; mode: string; tradesAnalyzed: number; trigger: string; weightsApplied: boolean }>;
}

interface BacktestResponse {
  tokensReplayed: number;
  results: Array<{
    preset: string;
    label: string;
    trades: number;
    winRate: number | null;
    roiPct: number | null;
    profitFactor: number | null;
    expectancyPct: number | null;
    maxDrawdownSol: number | null;
    avgHoldMinutes: number | null;
    totalPnlSol: number;
  }>;
  caveats: string[];
}

type StatsMode = "all" | "paper" | "live";

export default function AnalyticsPage() {
  const [mode, setMode] = useState<StatsMode>("all");
  const { data, reload } = usePoll<Analytics>(`/api/analytics?mode=${mode}`, 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [backtest, setBacktest] = useState<BacktestResponse | null>(null);

  const post = async (action: string) => {
    setBusy(action);
    setMessage(null);
    const res = await fetch("/api/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, mode }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    setMessage(
      res?.ok
        ? action === "generate"
          ? "✓ Strategy report generated"
          : "✓ Recommended weights applied — engine reloading"
        : ((body as { error?: string })?.error ?? "Request failed")
    );
    setBusy(null);
    reload();
  };

  const runBacktest = async () => {
    setBusy("backtest");
    setMessage(null);
    const res = await fetch("/api/backtest").catch(() => null);
    if (res?.ok) setBacktest((await res.json()) as BacktestResponse);
    else setMessage("Backtest failed — check the connection and try again");
    setBusy(null);
  };

  const s = data?.stats;

  return (
    <AppShell>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h1 className="text-xl font-semibold">Strategy analytics</h1>
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
        What the completed trades actually say: where the strategy makes and loses money, and the
        data-driven scoring-weight recommendation. Everything here is measured, never assumed.
      </p>

      {!data && <p className="text-sm text-slate-600">Loading…</p>}

      {data && s && (
        <>
          {/* Measured strategy adjustments */}
          <div className="card mb-4">
            <div className="stat-label mb-2">
              Recommended adjustments — from {s.trades} closed trades
            </div>
            <ul className="space-y-1.5">
              {data.adjustments.map((a, i) => (
                <li key={i} className="text-sm text-slate-300 flex gap-2">
                  <span className="text-accent shrink-0">→</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Bucket analyses */}
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
            <BucketTable title="Profit by market cap" buckets={s.byMarketCap} />
            <BucketTable title="Profit by liquidity" buckets={s.byLiquidity} />
            <BucketTable title="Profit by token age at entry" buckets={s.byTokenAge} />
            <BucketTable title="Profit by holding time" buckets={s.byHoldTime} />
          </div>

          {/* Win / loss reasons */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <ReasonTable title="Top reasons trades won" reasons={s.topWinReasons} tone="profit" />
            <ReasonTable title="Top reasons trades lost" reasons={s.topLossReasons} tone="loss" />
          </div>

          {/* Weight optimizer */}
          <div className="card mb-4">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
              <div className="stat-label">Score-weight optimizer</div>
              <div className="flex gap-2">
                <button
                  onClick={() => void post("generate")}
                  disabled={busy !== null}
                  className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-50"
                >
                  {busy === "generate" ? "Generating…" : "Generate report now"}
                </button>
                {data.recommendation && (
                  <button
                    onClick={() => void post("applyWeights")}
                    disabled={busy !== null}
                    className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50"
                  >
                    {busy === "applyWeights" ? "Applying…" : "Apply recommended weights"}
                  </button>
                )}
              </div>
            </div>
            {message && <p className="text-xs mb-2 text-slate-300">{message}</p>}
            {data.recommendation ? (
              <>
                <p className="text-xs text-slate-500 mb-3 max-w-4xl">{data.recommendation.summary}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-surface-border">
                        <th className="pb-1 pr-3 font-normal">Metric</th>
                        <th className="pb-1 pr-3 font-normal text-right">Samples</th>
                        <th className="pb-1 pr-3 font-normal text-right">Winners avg</th>
                        <th className="pb-1 pr-3 font-normal text-right">Losers avg</th>
                        <th className="pb-1 pr-3 font-normal text-right">Correlation</th>
                        <th className="pb-1 pr-3 font-normal text-right">Weight now</th>
                        <th className="pb-1 font-normal text-right">Recommended</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recommendation.evidence.map((e) => (
                        <tr key={e.metric} className="border-b border-surface-border/40">
                          <td className="py-1 pr-3 text-slate-300">{e.metric}</td>
                          <td className="py-1 pr-3 text-right text-slate-400">{e.samples}</td>
                          <td className="py-1 pr-3 text-right text-slate-400">{e.winnerMean?.toFixed(2) ?? "—"}</td>
                          <td className="py-1 pr-3 text-right text-slate-400">{e.loserMean?.toFixed(2) ?? "—"}</td>
                          <td className={`py-1 pr-3 text-right font-mono ${(e.correlation ?? 0) > 0.05 ? "text-profit" : (e.correlation ?? 0) < -0.05 ? "text-loss" : "text-slate-500"}`}>
                            {e.correlation != null ? e.correlation.toFixed(3) : "—"}
                          </td>
                          <td className="py-1 pr-3 text-right text-slate-400">{e.currentWeight}</td>
                          <td className={`py-1 text-right font-mono ${e.direction === "increase" ? "text-profit" : e.direction === "decrease" ? "text-loss" : "text-slate-400"}`}>
                            {e.recommendedWeight}
                            {e.direction === "increase" ? " ↑" : e.direction === "decrease" ? " ↓" : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-600">
                Needs at least {data.minTradesForOptimization} closed trades with entry snapshots —
                currently {s.trades}. The recommendation appears automatically once enough history exists.
              </p>
            )}
          </div>

          {/* Backtest */}
          <div className="card mb-4">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
              <div className="stat-label">Strategy backtest — replay recorded launches</div>
              <button
                onClick={() => void runBacktest()}
                disabled={busy !== null}
                className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50"
              >
                {busy === "backtest" ? "Replaying…" : "Run backtest"}
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-2 max-w-4xl">
              Replays the recorded score/price history of recently detected tokens against every
              strategy profile using the production exit engine. Directional comparison, not a
              guarantee: snapshot-price fills, ~15s resolution.
            </p>
            {backtest && (
              <>
                <p className="text-xs text-slate-400 mb-2">{backtest.tokensReplayed} tokens replayed.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-surface-border">
                        <th className="pb-1 pr-3 font-normal">Profile</th>
                        <th className="pb-1 pr-3 font-normal text-right">Trades</th>
                        <th className="pb-1 pr-3 font-normal text-right">Win %</th>
                        <th className="pb-1 pr-3 font-normal text-right">ROI %</th>
                        <th className="pb-1 pr-3 font-normal text-right">Profit factor</th>
                        <th className="pb-1 pr-3 font-normal text-right">Expectancy %</th>
                        <th className="pb-1 pr-3 font-normal text-right">Max DD (SOL)</th>
                        <th className="pb-1 font-normal text-right">Avg hold</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backtest.results.map((r) => (
                        <tr key={r.preset} className="border-b border-surface-border/40">
                          <td className="py-1 pr-3 text-slate-200">{r.label}</td>
                          <td className="py-1 pr-3 text-right text-slate-400">{r.trades}</td>
                          <td className="py-1 pr-3 text-right text-slate-400">{r.winRate?.toFixed(0) ?? "—"}%</td>
                          <td className={`py-1 pr-3 text-right font-mono ${(r.roiPct ?? 0) > 0 ? "text-profit" : (r.roiPct ?? 0) < 0 ? "text-loss" : "text-slate-400"}`}>
                            {r.roiPct != null ? `${r.roiPct >= 0 ? "+" : ""}${r.roiPct.toFixed(1)}` : "—"}
                          </td>
                          <td className="py-1 pr-3 text-right text-slate-400">{r.profitFactor?.toFixed(2) ?? "—"}</td>
                          <td className="py-1 pr-3 text-right text-slate-400">
                            {r.expectancyPct != null ? `${r.expectancyPct >= 0 ? "+" : ""}${r.expectancyPct.toFixed(1)}` : "—"}
                          </td>
                          <td className="py-1 pr-3 text-right text-slate-400">
                            {r.maxDrawdownSol != null ? `-${r.maxDrawdownSol.toFixed(3)}` : "—"}
                          </td>
                          <td className="py-1 text-right text-slate-400">
                            {r.avgHoldMinutes != null ? `${r.avgHoldMinutes.toFixed(1)}m` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="mt-2 space-y-0.5">
                  {backtest.caveats.map((c, i) => (
                    <li key={i} className="text-[10px] text-slate-600">· {c}</li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* Stored reports */}
          <div className="card">
            <div className="stat-label mb-2">Strategy reports</div>
            {data.reports.length === 0 ? (
              <p className="text-sm text-slate-600">
                None yet — generated automatically every N closed trades (Settings → “Strategy report
                every N trades”), or on demand above.
              </p>
            ) : (
              data.reports.map((r) => (
                <div key={r.id} className="flex items-center justify-between text-xs py-1 border-b border-surface-border/40 last:border-0">
                  <span className="text-slate-300">
                    {timeAgo(new Date(r.at))} ago · {r.tradesAnalyzed} trades · {r.trigger}
                  </span>
                  <span className={r.weightsApplied ? "text-profit" : "text-slate-500"}>
                    {r.weightsApplied ? "weights auto-applied" : "report only"}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}

function BucketTable({ title, buckets }: { title: string; buckets: BucketStat[] }) {
  return (
    <div className="card">
      <div className="stat-label mb-2">{title}</div>
      {buckets.length === 0 ? (
        <p className="text-sm text-slate-600">Not enough data yet.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b border-surface-border">
              <th className="pb-1 pr-2 font-normal"> </th>
              <th className="pb-1 pr-2 font-normal text-right">Trades</th>
              <th className="pb-1 pr-2 font-normal text-right">Win %</th>
              <th className="pb-1 font-normal text-right">PnL</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.label} className="border-b border-surface-border/40">
                <td className="py-1 pr-2 text-slate-300">{b.label.replace(/_/g, " ")}</td>
                <td className="py-1 pr-2 text-right text-slate-400">{b.trades}</td>
                <td className="py-1 pr-2 text-right text-slate-400">{b.winRate != null ? `${b.winRate.toFixed(0)}%` : "—"}</td>
                <td className={`py-1 text-right font-mono ${b.pnlSol > 0 ? "text-profit" : b.pnlSol < 0 ? "text-loss" : "text-slate-400"}`}>
                  {b.pnlSol >= 0 ? "+" : ""}{b.pnlSol.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReasonTable({ title, reasons, tone }: { title: string; reasons: ReasonStat[]; tone: "profit" | "loss" }) {
  return (
    <div className="card">
      <div className="stat-label mb-2">{title}</div>
      {reasons.length === 0 ? (
        <p className="text-sm text-slate-600">Not enough data yet.</p>
      ) : (
        <div className="space-y-1">
          {reasons.map((r) => (
            <div key={r.reason} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-300 truncate" title={r.reason}>{r.reason}</span>
              <span className="shrink-0 text-slate-500">
                ×{r.count} · <span className={tone === "profit" ? "text-profit" : "text-loss"}>{r.pnlSol >= 0 ? "+" : ""}{r.pnlSol.toFixed(3)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
