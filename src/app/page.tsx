"use client";

import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppShell } from "@/components/layout/AppShell";
import { TradingModeToggle } from "@/components/TradingModeToggle";
import { usePoll } from "@/components/usePoll";
import { ScoreBadge, Sol, StatCard, shortMint, timeAgo } from "@/components/ui";
import { HealthIndicators, type Health } from "@/components/HealthIndicators";

interface Stats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  successRate: number | null;
  realizedSol: number;
  dailyRealizedSol: number;
  weeklyRealizedSol: number;
  monthlyRealizedSol: number;
  openPositions: number;
  exposureSol: number;
  closedPositions: number;
  winRate: number | null;
  roiPct: number | null;
  avgRoiPct: number | null;
  avgHoldMinutes: number | null;
  avgPnlSol: number | null;
  largestWinSol: number | null;
  largestLossSol: number | null;
  equityCurve: Array<{ date: string; realizedSol: number; cumulativeSol: number }>;
  today: { realizedSol: number; trades: number; scanned: number; bought: number; rejected: number } | null;
}

type StatsMode = "all" | "paper" | "live";


interface PositionRow {
  id: string;
  mint: string;
  status: string;
  paper: boolean;
  entrySol: number;
  entryPriceUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  entryReason: string;
  exitReason: string | null;
  openedAt: string;
}

interface TokenRow {
  mint: string;
  score: number | null;
  verdict: string | null;
  critical: boolean;
  greenFlags: string[];
  redFlags: string[];
  detectedAt: string;
}

interface FeedEvent {
  at: number;
  level: string;
  source: string;
  message: string;
}

interface TrendingRow {
  mint: string;
  symbol: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  change24hPct: number | null;
  url: string;
}

export default function Dashboard() {
  const [mode, setMode] = useState<StatsMode>("all");
  const { data: stats } = usePoll<Stats>(`/api/stats?mode=${mode}`, 10_000);
  const { data: health } = usePoll<Health>("/api/health", 10_000);
  const { data: positions } = usePoll<PositionRow[]>("/api/positions?status=OPEN", 5_000);
  const { data: tokens } = usePoll<TokenRow[]>("/api/tokens?limit=8", 8_000);
  const { data: trending } = usePoll<TrendingRow[]>("/api/trending", 60_000);
  const feed = useLiveFeed();

  return (
    <AppShell>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h1 className="text-xl font-semibold">Dashboard</h1>
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

      {/* Engine / scanner health indicators */}
      <HealthIndicators health={health} />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
        <StatCard
          label="Realized PnL"
          value={stats ? `${stats.realizedSol >= 0 ? "+" : ""}${stats.realizedSol.toFixed(3)}` : "…"}
          sub="SOL, all time"
          tone={stats && stats.realizedSol !== 0 ? (stats.realizedSol > 0 ? "profit" : "loss") : "neutral"}
        />
        <StatCard
          label="ROI"
          value={stats?.roiPct != null ? `${stats.roiPct.toFixed(1)}%` : "—"}
          sub={`avg ${stats?.avgRoiPct != null ? `${stats.avgRoiPct.toFixed(1)}%` : "—"} per trade`}
          tone={stats?.roiPct != null ? (stats.roiPct > 0 ? "profit" : "loss") : "neutral"}
        />
        <StatCard
          label="Win rate"
          value={stats?.winRate != null ? `${stats.winRate.toFixed(0)}%` : "—"}
          sub={`${stats?.winningTrades ?? 0}W · ${stats?.losingTrades ?? 0}L of ${stats?.closedPositions ?? 0}`}
        />
        <StatCard
          label="Open positions"
          value={String(stats?.openPositions ?? 0)}
          sub={`${stats?.exposureSol.toFixed(3) ?? "0"} SOL exposure`}
        />
        <StatCard
          label="Profit 24h"
          value={stats ? `${stats.dailyRealizedSol >= 0 ? "+" : ""}${stats.dailyRealizedSol.toFixed(3)}` : "…"}
          sub={`7d ${stats ? (stats.weeklyRealizedSol >= 0 ? "+" : "") + stats.weeklyRealizedSol.toFixed(3) : "…"} · 30d ${stats ? (stats.monthlyRealizedSol >= 0 ? "+" : "") + stats.monthlyRealizedSol.toFixed(3) : "…"}`}
          tone={stats && stats.dailyRealizedSol !== 0 ? (stats.dailyRealizedSol > 0 ? "profit" : "loss") : "neutral"}
        />
        <StatCard
          label="Scanned today"
          value={String(stats?.today?.scanned ?? 0)}
          sub={`${stats?.today?.bought ?? 0} bought · ${stats?.today?.rejected ?? 0} rejected`}
        />
      </div>

      {/* Performance detail */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard
          label="Avg hold time"
          value={stats?.avgHoldMinutes != null ? `${stats.avgHoldMinutes.toFixed(0)}m` : "—"}
          sub={`${stats?.totalTrades ?? 0} trades executed`}
        />
        <StatCard
          label="Avg PnL / trade"
          value={stats?.avgPnlSol != null ? `${stats.avgPnlSol >= 0 ? "+" : ""}${stats.avgPnlSol.toFixed(4)}` : "—"}
          tone={stats?.avgPnlSol != null ? (stats.avgPnlSol > 0 ? "profit" : "loss") : "neutral"}
        />
        <StatCard
          label="Largest winner"
          value={stats?.largestWinSol != null ? `+${stats.largestWinSol.toFixed(4)}` : "—"}
          tone="profit"
        />
        <StatCard
          label="Largest loser"
          value={stats?.largestLossSol != null ? stats.largestLossSol.toFixed(4) : "—"}
          tone={stats?.largestLossSol ? "loss" : "neutral"}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* PnL chart */}
        <div className="card lg:col-span-2">
          <div className="stat-label mb-3">
            Equity curve — cumulative realized PnL (SOL{mode !== "all" ? `, ${mode} trades` : ""})
          </div>
          <div className="h-56">
            {stats && stats.equityCurve.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.equityCurve} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="pnl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    stroke="#475569"
                    fontSize={11}
                  />
                  <YAxis stroke="#475569" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: "#161b28", border: "1px solid #232a3b", borderRadius: 8 }}
                    labelFormatter={(d) => new Date(d as string).toLocaleDateString()}
                  />
                  <Area type="monotone" dataKey="cumulativeSol" stroke="#6366f1" fill="url(#pnl)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-slate-600">
                No closed trades yet — the graph fills in as the bot trades.
              </div>
            )}
          </div>
        </div>

        {/* Mode toggle + scanner feed */}
        <div className="space-y-4">
          <TradingModeToggle />
          <div className="card">
            <div className="stat-label mb-3">Latest detections</div>
            <div className="space-y-2 max-h-56 overflow-y-auto">
            {(tokens ?? []).map((t) => (
              <div key={t.mint} className="flex items-center justify-between gap-2 text-sm animate-slide-in">
                <div className="min-w-0">
                  <span className="font-mono text-slate-300">{shortMint(t.mint)}</span>
                  <span className="text-slate-600 text-xs ml-2">{timeAgo(t.detectedAt)}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-slate-500">{t.verdict ?? "EVALUATING"}</span>
                  <ScoreBadge score={t.score} critical={t.critical} />
                </div>
              </div>
            ))}
              {(!tokens || tokens.length === 0) && (
                <p className="text-sm text-slate-600">Waiting for migrations…</p>
              )}
            </div>
          </div>
          <div className="card">
            <div className="stat-label mb-1">Trending on Solana</div>
            <p className="text-[10px] text-slate-600 mb-2">
              DexScreener boosted tokens — paid attention, not quality. Informational only; never
              feeds buy decisions.
            </p>
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {(trending ?? []).map((t) => (
                <a
                  key={t.mint}
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 text-sm hover:bg-surface-overlay/50 rounded px-1 -mx-1"
                >
                  <div className="min-w-0 truncate">
                    <span className="text-slate-200">{t.symbol ?? shortMint(t.mint)}</span>
                    {t.marketCapUsd != null && (
                      <span className="text-slate-600 text-xs ml-2">
                        ${t.marketCapUsd >= 1e6 ? `${(t.marketCapUsd / 1e6).toFixed(1)}M` : `${(t.marketCapUsd / 1e3).toFixed(0)}K`} MC
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    {t.priceUsd != null && (
                      <span className="font-mono text-slate-400">
                        ${t.priceUsd < 0.001 ? t.priceUsd.toPrecision(3) : t.priceUsd.toFixed(4)}
                      </span>
                    )}
                    {t.change24hPct != null && (
                      <span className={t.change24hPct >= 0 ? "text-profit" : "text-loss"}>
                        {t.change24hPct >= 0 ? "▲" : "▼"} {Math.abs(t.change24hPct).toFixed(1)}%
                      </span>
                    )}
                  </div>
                </a>
              ))}
              {(!trending || trending.length === 0) && (
                <p className="text-sm text-slate-600">No trending data right now</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Open positions */}
      <div className="card mt-4">
        <div className="stat-label mb-3">Open positions</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-surface-border">
                <th className="pb-2 pr-4">Token</th>
                <th className="pb-2 pr-4">Mode</th>
                <th className="pb-2 pr-4">Entry</th>
                <th className="pb-2 pr-4">Opened</th>
                <th className="pb-2">Entry reason</th>
              </tr>
            </thead>
            <tbody>
              {(positions ?? []).map((p) => (
                <tr key={p.id} className="border-b border-surface-border/50">
                  <td className="py-2 pr-4 font-mono">{shortMint(p.mint)}</td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${p.paper ? "bg-surface-overlay text-slate-400" : "bg-accent/20 text-accent"}`}>
                      {p.paper ? "paper" : "live"}
                    </span>
                  </td>
                  <td className="py-2 pr-4"><Sol value={p.entrySol} /></td>
                  <td className="py-2 pr-4 text-slate-400">{timeAgo(p.openedAt)} ago</td>
                  <td className="py-2 text-xs text-slate-500 max-w-md truncate" title={p.entryReason}>
                    {p.entryReason}
                  </td>
                </tr>
              ))}
              {(!positions || positions.length === 0) && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-600">
                    No open positions
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Live feed */}
      <div className="card mt-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="stat-label">Live engine feed</div>
          <span className={`w-1.5 h-1.5 rounded-full ${feed.connected ? "bg-profit" : "bg-slate-600"}`} />
        </div>
        <div className="font-mono text-xs space-y-1 max-h-48 overflow-y-auto">
          {feed.events.map((e, i) => (
            <div key={i} className="flex gap-2 animate-slide-in">
              <span className="text-slate-600 shrink-0">
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <span
                className={`shrink-0 ${
                  e.level === "error" ? "text-loss" : e.level === "warn" ? "text-warn" : "text-accent"
                }`}
              >
                [{e.source}]
              </span>
              <span className="text-slate-400">{e.message}</span>
            </div>
          ))}
          {feed.events.length === 0 && (
            <p className="text-slate-600">Engine feed connects when the worker is running.</p>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function useLiveFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const ref = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/feed");
    ref.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as FeedEvent & { ping?: number };
        if (data.ping) return;
        setEvents((prev) => [data, ...prev].slice(0, 100));
      } catch {
        /* ignore malformed */
      }
    };
    return () => es.close();
  }, []);

  return { events, connected };
}
