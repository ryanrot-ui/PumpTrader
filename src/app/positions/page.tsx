"use client";

import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { Sol, ScoreBadge, shortMint, timeAgo } from "@/components/ui";

interface TradeRow {
  side: string;
  signature: string | null;
  reason: string;
  latencyMs: number | null;
  retries: number;
  createdAt: string;
}

interface PositionRow {
  id: string;
  mint: string;
  symbol: string | null;
  status: string;
  paper: boolean;
  entrySol: number;
  entryPriceUsd: number | null;
  exitSol: number | null;
  exitPriceUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  maxUnrealizedPnlPct: number | null;
  maxDrawdownPct: number | null;
  entryReason: string;
  exitReason: string | null;
  scannerScore: number | null;
  scoreExplanation: string | null;
  openedAt: string;
  closedAt: string | null;
  trades: TradeRow[];
}

function holdTime(p: PositionRow): string {
  const end = p.closedAt ? new Date(p.closedAt).getTime() : Date.now();
  const mins = (end - new Date(p.openedAt).getTime()) / 60_000;
  if (mins < 60) return `${mins.toFixed(0)}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

export default function PositionsPage() {
  const [tab, setTab] = useState<"OPEN" | "CLOSED">("OPEN");
  const [expanded, setExpanded] = useState<string | null>(null);
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
              <th className="pb-2 pr-4">Score</th>
              <th className="pb-2 pr-4">Mode</th>
              <th className="pb-2 pr-4">Entry</th>
              {tab === "CLOSED" && (
                <>
                  <th className="pb-2 pr-4">Exit</th>
                  <th className="pb-2 pr-4">PnL</th>
                  <th className="pb-2 pr-4">ROI</th>
                </>
              )}
              <th className="pb-2 pr-4">Held</th>
              <th className="pb-2">Links</th>
            </tr>
          </thead>
          <tbody>
            {(positions ?? []).map((p) => (
              <>
                <tr
                  key={p.id}
                  onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                  className="border-b border-surface-border/50 hover:bg-surface-overlay/50 cursor-pointer"
                >
                  <td className="py-2 pr-4 font-mono">
                    {p.symbol ? `${p.symbol} · ` : ""}
                    {shortMint(p.mint)}
                  </td>
                  <td className="py-2 pr-4">
                    <ScoreBadge score={p.scannerScore} />
                  </td>
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
                        <Sol value={p.exitSol} />
                      </td>
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
                  <td className="py-2 pr-4 text-slate-400">{holdTime(p)}</td>
                  <td className="py-2 text-xs whitespace-nowrap">
                    <a
                      href={`https://dexscreener.com/solana/${p.mint}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline mr-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      chart ↗
                    </a>
                    <a
                      href={`https://solscan.io/token/${p.mint}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      explorer ↗
                    </a>
                  </td>
                </tr>
                {expanded === p.id && (
                  <tr key={`${p.id}-detail`} className="bg-surface-overlay/30">
                    <td colSpan={9} className="p-4 text-xs space-y-2">
                      <div className="grid md:grid-cols-2 gap-x-8 gap-y-2">
                        <div>
                          <span className="text-slate-500">Entry:</span>{" "}
                          <span className="font-mono text-slate-300">
                            {p.entrySol} SOL @ ${p.entryPriceUsd?.toPrecision(4) ?? "?"} ·{" "}
                            {new Date(p.openedAt).toLocaleString()}
                          </span>
                        </div>
                        {p.closedAt && (
                          <div>
                            <span className="text-slate-500">Exit:</span>{" "}
                            <span className="font-mono text-slate-300">
                              {p.exitSol?.toFixed(4)} SOL @ ${p.exitPriceUsd?.toPrecision(4) ?? "?"} ·{" "}
                              {new Date(p.closedAt).toLocaleString()}
                            </span>
                          </div>
                        )}
                        <div>
                          <span className="text-slate-500">Max unrealized profit:</span>{" "}
                          <span className="font-mono text-profit">
                            {p.maxUnrealizedPnlPct != null
                              ? `${p.maxUnrealizedPnlPct > 0 ? "+" : ""}${p.maxUnrealizedPnlPct.toFixed(1)}%`
                              : "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">Max drawdown from peak:</span>{" "}
                          <span className="font-mono text-loss">
                            {p.maxDrawdownPct != null ? `−${p.maxDrawdownPct.toFixed(1)}%` : "—"}
                          </span>
                        </div>
                        <div className="md:col-span-2">
                          <span className="text-slate-500">Buy reasons:</span>{" "}
                          <span className="text-slate-300">{p.entryReason}</span>
                        </div>
                        {p.exitReason && (
                          <div className="md:col-span-2">
                            <span className="text-slate-500">Sell reason:</span>{" "}
                            <span className="text-slate-300">{p.exitReason}</span>
                          </div>
                        )}
                        {p.scoreExplanation && (
                          <div className="md:col-span-2">
                            <span className="text-slate-500">Score explanation:</span>{" "}
                            <span className="text-slate-400">{p.scoreExplanation}</span>
                          </div>
                        )}
                        <div className="md:col-span-2">
                          <span className="text-slate-500">Transactions:</span>{" "}
                          {p.trades.map((t) =>
                            t.signature ? (
                              <a
                                key={t.signature}
                                href={`https://solscan.io/tx/${t.signature}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent hover:underline mr-3 font-mono"
                              >
                                {t.side} {t.signature.slice(0, 8)}…
                                {t.latencyMs ? ` (${t.latencyMs}ms${t.retries ? `, ${t.retries} retries` : ""})` : ""} ↗
                              </a>
                            ) : (
                              <span key={`${t.side}-${t.createdAt}`} className="text-slate-500 mr-3">
                                {t.side} (paper{t.latencyMs ? `, ${t.latencyMs}ms` : ""})
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
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
      <p className="text-[10px] text-slate-600 mt-2">Click a row for full details.</p>
    </AppShell>
  );
}
