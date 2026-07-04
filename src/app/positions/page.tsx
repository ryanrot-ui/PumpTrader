"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { Sol, shortMint, timeAgo } from "@/components/ui";

interface PositionRow {
  id: string;
  mint: string;
  status: string;
  paper: boolean;
  entrySol: number;
  entryPriceUsd: number | null;
  exitPriceUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  entryReason: string;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
  trades: Array<{ side: string; signature: string | null; reason: string }>;
}

export default function PositionsPage() {
  const [tab, setTab] = useState<"OPEN" | "CLOSED">("OPEN");
  const { data: positions } = usePoll<PositionRow[]>(`/api/positions?status=${tab}`, 5000);

  return (
    <AppShell>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Positions</h1>
        <div className="flex gap-1.5">
          {(["OPEN", "CLOSED"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`btn text-xs ${tab === t ? "btn-primary" : "btn-ghost"}`}
            >
              {t === "OPEN" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-surface-border">
              <th className="pb-2 pr-4">Token</th>
              <th className="pb-2 pr-4">Mode</th>
              <th className="pb-2 pr-4">Entry</th>
              {tab === "CLOSED" && (
                <>
                  <th className="pb-2 pr-4">PnL</th>
                  <th className="pb-2 pr-4">PnL %</th>
                </>
              )}
              <th className="pb-2 pr-4">{tab === "OPEN" ? "Opened" : "Closed"}</th>
              <th className="pb-2 pr-4">Entry reason</th>
              {tab === "CLOSED" && <th className="pb-2 pr-4">Exit reason</th>}
              <th className="pb-2">Tx</th>
            </tr>
          </thead>
          <tbody>
            {(positions ?? []).map((p) => (
              <tr key={p.id} className="border-b border-surface-border/50">
                <td className="py-2 pr-4 font-mono">{shortMint(p.mint)}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${p.paper ? "bg-surface-overlay text-slate-400" : "bg-accent/20 text-accent"}`}
                  >
                    {p.paper ? "paper" : "live"}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  <Sol value={p.entrySol} />
                </td>
                {tab === "CLOSED" && (
                  <>
                    <td className="py-2 pr-4">
                      <Sol value={p.pnlSol} sign />
                    </td>
                    <td
                      className={`py-2 pr-4 font-mono ${(p.pnlPct ?? 0) > 0 ? "text-profit" : "text-loss"}`}
                    >
                      {p.pnlPct != null ? `${p.pnlPct > 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%` : "—"}
                    </td>
                  </>
                )}
                <td className="py-2 pr-4 text-slate-400">
                  {timeAgo(tab === "OPEN" ? p.openedAt : (p.closedAt ?? p.openedAt))} ago
                </td>
                <td className="py-2 pr-4 text-xs text-slate-500 max-w-xs truncate" title={p.entryReason}>
                  {p.entryReason}
                </td>
                {tab === "CLOSED" && (
                  <td className="py-2 pr-4 text-xs text-slate-500 max-w-xs truncate" title={p.exitReason ?? ""}>
                    {p.exitReason ?? "—"}
                  </td>
                )}
                <td className="py-2 text-xs">
                  {p.trades
                    .filter((t) => t.signature)
                    .map((t) => (
                      <a
                        key={t.signature}
                        href={`https://solscan.io/tx/${t.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline mr-2"
                      >
                        {t.side.toLowerCase()} ↗
                      </a>
                    ))}
                  {p.trades.every((t) => !t.signature) && <span className="text-slate-600">paper</span>}
                </td>
              </tr>
            ))}
            {(!positions || positions.length === 0) && (
              <tr>
                <td colSpan={9} className="py-6 text-center text-slate-600">
                  No {tab.toLowerCase()} positions
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
