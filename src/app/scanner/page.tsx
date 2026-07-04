"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { FlagPills, ScoreBadge, shortMint, timeAgo } from "@/components/ui";
import { PriceChart, type PricePoint, type TradeMarker } from "@/components/charts/PriceChart";

interface MetricRow {
  metric: string;
  value: number;
  weight: number;
  contribution: number;
  detail: string;
}

interface TokenRow {
  mint: string;
  symbol: string | null;
  detectedAt: string;
  migratedAt: string;
  verdict: string | null;
  rejectionReasons: string[];
  score: number | null;
  greenFlags: string[];
  redFlags: string[];
  critical: boolean;
  breakdown: MetricRow[] | null;
  snapshot: {
    priceUsd: number | null;
    liquiditySol: number | null;
    marketCapUsd: number | null;
    holderCount: number | null;
  } | null;
}

interface TokenDetail {
  snapshots: Array<{ at: string; priceUsd: number | null; volume5mUsd: number | null }>;
  trades: Array<{ side: string; createdAt: string; reason: string }>;
}

export default function ScannerPage() {
  const { data: tokens } = usePoll<TokenRow[]>("/api/tokens?limit=100", 8000);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const filtered = (tokens ?? []).filter((t) => {
    if (filter === "candidates") return t.verdict === "BUY_CANDIDATE" || t.verdict === "BOUGHT";
    if (filter === "rejected") return t.verdict === "REJECTED";
    if (filter === "high") return (t.score ?? 0) >= 70;
    return true;
  });

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-xl font-semibold">Token scanner</h1>
        <div className="flex gap-1.5">
          {(["all", "high", "candidates", "rejected"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`btn text-xs ${filter === f ? "btn-primary" : "btn-ghost"}`}
            >
              {f === "all" ? "All" : f === "high" ? "Score ≥ 70" : f === "candidates" ? "Bought" : "Rejected"}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-surface-border">
              <th className="pb-2 pr-4">Token</th>
              <th className="pb-2 pr-4">Score</th>
              <th className="pb-2 pr-4">Price</th>
              <th className="pb-2 pr-4">Liq (SOL)</th>
              <th className="pb-2 pr-4">MCap</th>
              <th className="pb-2 pr-4">Holders</th>
              <th className="pb-2 pr-4">Verdict</th>
              <th className="pb-2">Age</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr
                key={t.mint}
                onClick={() => setSelected(selected === t.mint ? null : t.mint)}
                className="border-b border-surface-border/50 hover:bg-surface-overlay/50 cursor-pointer"
              >
                <td className="py-2 pr-4 font-mono">
                  {t.symbol ? `${t.symbol} · ` : ""}
                  {shortMint(t.mint)}
                </td>
                <td className="py-2 pr-4">
                  <ScoreBadge score={t.score} critical={t.critical} />
                </td>
                <td className="py-2 pr-4 font-mono text-slate-400">
                  {t.snapshot?.priceUsd ? `$${t.snapshot.priceUsd.toPrecision(3)}` : "—"}
                </td>
                <td className="py-2 pr-4 font-mono text-slate-400">
                  {t.snapshot?.liquiditySol?.toFixed(0) ?? "—"}
                </td>
                <td className="py-2 pr-4 font-mono text-slate-400">
                  {t.snapshot?.marketCapUsd ? `$${Math.round(t.snapshot.marketCapUsd / 1000)}k` : "—"}
                </td>
                <td className="py-2 pr-4 font-mono text-slate-400">{t.snapshot?.holderCount ?? "—"}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      t.verdict === "BOUGHT"
                        ? "bg-profit/20 text-profit"
                        : t.verdict === "REJECTED"
                          ? "bg-surface-overlay text-slate-500"
                          : "bg-warn/10 text-warn"
                    }`}
                  >
                    {t.verdict ?? "EVALUATING"}
                  </span>
                </td>
                <td className="py-2 text-slate-500 text-xs">{timeAgo(t.migratedAt)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-slate-600">
                  Nothing detected yet — the scanner populates this list as tokens migrate.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <TokenDrawer token={filtered.find((t) => t.mint === selected) ?? null} />}
    </AppShell>
  );
}

function TokenDrawer({ token }: { token: TokenRow | null }) {
  const { data: detail } = usePoll<TokenDetail>(
    token ? `/api/tokens/${token.mint}` : "/api/tokens?limit=0",
    10_000
  );
  if (!token) return null;

  const points: PricePoint[] = (detail?.snapshots ?? [])
    .filter((s) => s.priceUsd != null)
    .map((s) => ({
      time: Math.floor(new Date(s.at).getTime() / 1000),
      price: s.priceUsd!,
      volume: s.volume5mUsd,
    }));
  const markers: TradeMarker[] = (detail?.trades ?? []).map((t) => ({
    time: Math.floor(new Date(t.createdAt).getTime() / 1000),
    side: t.side as "BUY" | "SELL",
    label: t.side,
  }));

  return (
    <div className="card mt-4 animate-slide-in">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <span className="font-mono text-slate-200">{token.mint}</span>
          <a
            href={`https://dexscreener.com/solana/${token.mint}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent text-xs ml-3 hover:underline"
          >
            DexScreener ↗
          </a>
        </div>
        <ScoreBadge score={token.score} critical={token.critical} />
      </div>

      <PriceChart points={points} markers={markers} />

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div>
          <div className="stat-label mb-2">Flags</div>
          <div className="space-y-2">
            <FlagPills flags={token.greenFlags} kind="green" />
            <FlagPills flags={token.redFlags} kind="red" />
            {token.greenFlags.length === 0 && token.redFlags.length === 0 && (
              <p className="text-xs text-slate-600">No flags recorded yet</p>
            )}
          </div>
          {token.rejectionReasons.length > 0 && (
            <div className="mt-3">
              <div className="stat-label mb-1">Rejection reasons</div>
              <ul className="text-xs text-slate-400 space-y-0.5 list-disc list-inside">
                {token.rejectionReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <div className="stat-label mb-2">Score breakdown</div>
          <div className="space-y-1.5">
            {(token.breakdown ?? []).map((m) => (
              <div key={m.metric} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 text-slate-400">{m.metric}</span>
                <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${m.value >= 0.7 ? "bg-profit" : m.value >= 0.4 ? "bg-warn" : "bg-loss"}`}
                    style={{ width: `${m.value * 100}%` }}
                  />
                </div>
                <span className="w-32 shrink-0 text-slate-500 truncate" title={m.detail}>
                  {m.detail}
                </span>
              </div>
            ))}
            {!token.breakdown && <p className="text-xs text-slate-600">Not scored yet</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
