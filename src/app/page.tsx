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
import { usePoll } from "@/components/usePoll";
import { ScoreBadge, Sol, StatCard, shortMint, timeAgo } from "@/components/ui";

interface Stats {
  realizedSol: number;
  openPositions: number;
  exposureSol: number;
  closedPositions: number;
  winRate: number | null;
  roiPct: number | null;
  pnlSeries: Array<{ date: string; realizedSol: number; cumulativeSol: number }>;
  today: { realizedSol: number; trades: number; scanned: number; bought: number } | null;
}

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

export default function Dashboard() {
  const { data: stats } = usePoll<Stats>("/api/stats", 10_000);
  const { data: positions } = usePoll<PositionRow[]>("/api/positions?status=OPEN", 5_000);
  const { data: tokens } = usePoll<TokenRow[]>("/api/tokens?limit=8", 8_000);
  const feed = useLiveFeed();

  return (
    <AppShell>
      <h1 className="text-xl font-semibold mb-4">Dashboard</h1>

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
          sub="on closed positions"
          tone={stats?.roiPct != null ? (stats.roiPct > 0 ? "profit" : "loss") : "neutral"}
        />
        <StatCard
          label="Win rate"
          value={stats?.winRate != null ? `${stats.winRate.toFixed(0)}%` : "—"}
          sub={`${stats?.closedPositions ?? 0} closed`}
        />
        <StatCard
          label="Open positions"
          value={String(stats?.openPositions ?? 0)}
          sub={`${stats?.exposureSol.toFixed(3) ?? "0"} SOL exposure`}
        />
        <StatCard
          label="Today"
          value={stats?.today ? `${stats.today.realizedSol >= 0 ? "+" : ""}${stats.today.realizedSol.toFixed(3)}` : "0.000"}
          sub={`${stats?.today?.trades ?? 0} trades`}
          tone={stats?.today && stats.today.realizedSol !== 0 ? (stats.today.realizedSol > 0 ? "profit" : "loss") : "neutral"}
        />
        <StatCard
          label="Scanned today"
          value={String(stats?.today?.scanned ?? 0)}
          sub={`${stats?.today?.bought ?? 0} bought`}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* PnL chart */}
        <div className="card lg:col-span-2">
          <div className="stat-label mb-3">Cumulative realized PnL (SOL)</div>
          <div className="h-56">
            {stats && stats.pnlSeries.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.pnlSeries} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
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

        {/* Scanner feed */}
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
