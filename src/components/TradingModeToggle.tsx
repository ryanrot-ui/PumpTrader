"use client";

import { useState } from "react";
import { usePoll } from "./usePoll";

interface BotStatus {
  paperTrading: boolean;
  status: string;
}

/**
 * Paper / Live mode switch. Paper mode activates with one click; switching to
 * live opens a confirmation dialog that spells out that real funds will be
 * used and requires an explicit acknowledgement. The server additionally
 * refuses live mode without `confirmLive: true` and without an imported bot
 * wallet, so the dialog cannot be bypassed. The choice persists in the
 * user's settings row and the engine hot-reloads it immediately.
 */
export function TradingModeToggle() {
  const { data: bot, reload } = usePoll<BotStatus>("/api/bot", 5_000);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paper = bot?.paperTrading ?? true;

  const setMode = async (paperTrading: boolean, confirmLive = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_mode", paperTrading, confirmLive }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to switch mode");
        return;
      }
      setConfirming(false);
      setAcknowledged(false);
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="stat-label mb-3">Trading mode</div>
      <div className="space-y-2">
        <ModeRow
          label="Paper trading"
          active={paper}
          tone="paper"
          hint="real market data, simulated fills — no transactions are ever sent"
          disabled={busy || paper}
          onClick={() => void setMode(true)}
        />
        <ModeRow
          label="Live trading"
          active={!paper}
          tone="live"
          hint="real SOL from the imported bot wallet"
          disabled={busy || !paper}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        />
      </div>
      {error && <p className="text-loss text-xs mt-2">{error}</p>}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="card max-w-md w-full border border-warn/40">
            <h2 className="text-base font-semibold text-warn mb-2">Enable live trading?</h2>
            <div className="text-sm text-slate-300 space-y-2 mb-4">
              <p>
                Live mode executes <strong>real transactions with real SOL</strong> from your
                imported bot wallet. Newly migrated meme coins are extremely volatile —
                losses up to the full trade size (and the daily loss limit) are possible.
              </p>
              <p>
                Trades fire only when your configured filters and risk checks pass, but no
                filter can guarantee profits or protect against rug pulls.
              </p>
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-300 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="accent-amber-500 mt-0.5"
              />
              I understand that real funds will be used and I accept the risk of loss.
            </label>
            {error && <p className="text-loss text-xs mb-3">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button
                className="btn-ghost text-xs"
                onClick={() => {
                  setConfirming(false);
                  setAcknowledged(false);
                  setError(null);
                }}
              >
                Cancel — stay in paper mode
              </button>
              <button
                className="btn-danger text-xs"
                disabled={!acknowledged || busy}
                onClick={() => void setMode(false, true)}
              >
                {busy ? "Switching…" : "Enable live trading"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModeRow({
  label,
  active,
  tone,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  tone: "paper" | "live";
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <span className={`text-sm ${active ? "text-slate-100" : "text-slate-400"}`}>{label}</span>
        <span className="text-[10px] text-slate-600 block">{hint}</span>
      </div>
      <button
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        className={`shrink-0 text-xs font-semibold px-3 py-1 rounded-full border transition-colors ${
          active
            ? tone === "live"
              ? "bg-loss/20 border-loss/50 text-loss"
              : "bg-profit/20 border-profit/50 text-profit"
            : "bg-surface-overlay border-surface-border text-slate-500 hover:text-slate-300"
        } ${disabled && !active ? "opacity-60" : ""}`}
      >
        {active ? "ON" : "OFF"}
      </button>
    </div>
  );
}
