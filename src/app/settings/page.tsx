"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { usePoll } from "@/components/usePoll";
import { shortMint } from "@/components/ui";

type SettingsForm = Record<string, number | boolean | null>;

const SECTIONS: Array<{
  title: string;
  fields: Array<{ key: string; label: string; hint?: string; nullable?: boolean }>;
}> = [
  {
    title: "Buying",
    fields: [
      { key: "buyAmountSol", label: "Buy amount (SOL)" },
      { key: "confidenceThreshold", label: "Confidence threshold (0–100)", hint: "only buy at or above this score" },
      { key: "minLiquiditySol", label: "Minimum liquidity (SOL)" },
      { key: "minMarketCapUsd", label: "Minimum market cap (USD)" },
      { key: "maxMarketCapUsd", label: "Maximum market cap (USD)" },
      { key: "minHolders", label: "Minimum holders" },
      { key: "minVolume5mUsd", label: "Minimum 5m volume (USD)" },
      { key: "maxSlippageBps", label: "Max slippage (bps)", hint: "100 bps = 1%" },
    ],
  },
  {
    title: "Selling",
    fields: [
      { key: "takeProfitPct", label: "Take profit (%)", hint: "default 100 = cash out at 2×" },
      { key: "stopLossPct", label: "Stop loss (%)" },
      { key: "trailingStopPct", label: "Trailing stop (%)", nullable: true, hint: "empty = disabled" },
      { key: "maxHoldMinutes", label: "Time-based exit (minutes)", nullable: true, hint: "empty = disabled" },
      { key: "sellPortionPct", label: "Sell portion at TP (%)" },
    ],
  },
  {
    title: "Risk management",
    fields: [
      { key: "maxSolPerTrade", label: "Max SOL per trade" },
      { key: "maxOpenPositions", label: "Max open positions" },
      { key: "maxDailyLossSol", label: "Daily loss limit (SOL)" },
      { key: "dailyProfitTarget", label: "Daily profit target (SOL)", nullable: true, hint: "stop for the day once reached; empty = disabled" },
      { key: "maxExposureSol", label: "Max total exposure (SOL)" },
      { key: "lossCooldownMin", label: "Cooldown after a loss (min)" },
    ],
  },
];

export default function SettingsPage() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setForm)
      .catch(() => setError("Failed to load settings"));
  }, []);

  const save = async () => {
    if (!form) return;
    setError(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Save failed");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const setNum = (key: string, raw: string, nullable?: boolean) => {
    if (!form) return;
    if (raw === "" && nullable) setForm({ ...form, [key]: null });
    else {
      const n = parseFloat(raw);
      if (!Number.isNaN(n)) setForm({ ...form, [key]: n });
    }
  };

  return (
    <AppShell>
      <h1 className="text-xl font-semibold mb-4">Settings</h1>
      <p className="text-sm text-slate-500 mb-4 max-w-3xl">
        Every value applies immediately — the engine hot-reloads on save, no restart needed.
        These thresholds control what the bot buys and when it exits; nothing here can
        guarantee profitable trades on newly migrated tokens, which are extremely volatile.
      </p>

      {form && (
        <>
          {/* Mode toggles */}
          <div className="card mb-4 flex flex-wrap gap-6 items-center">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(form.paperTrading)}
                onChange={(e) => setForm({ ...form, paperTrading: e.target.checked })}
                className="accent-indigo-500 w-4 h-4"
              />
              <span>
                Paper trading{" "}
                <span className="text-slate-500 text-xs">(simulated fills, no real SOL — recommended)</span>
              </span>
            </label>
            {!form.paperTrading && (
              <span className="text-xs text-warn bg-warn/10 border border-warn/30 rounded px-2 py-1">
                ⚠ LIVE MODE — trades spend real SOL from the imported bot wallet
              </span>
            )}
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            {SECTIONS.map((section) => (
              <div key={section.title} className="card">
                <div className="stat-label mb-3">{section.title}</div>
                <div className="space-y-3">
                  {section.fields.map((f) => (
                    <div key={f.key}>
                      <label className="text-xs text-slate-400 block mb-1">{f.label}</label>
                      <input
                        className="input"
                        type="number"
                        step="any"
                        value={form[f.key] === null ? "" : String(form[f.key])}
                        placeholder={f.nullable ? "disabled" : undefined}
                        onChange={(e) => setNum(f.key, e.target.value, f.nullable)}
                      />
                      {f.hint && <p className="text-[10px] text-slate-600 mt-0.5">{f.hint}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-4">
            <button onClick={save} className="btn-primary px-6 py-2">
              Save settings
            </button>
            {saved && <span className="text-profit text-sm">✓ Saved — engine reloading</span>}
            {error && <span className="text-loss text-sm">{error}</span>}
          </div>
        </>
      )}

      <WalletPanel />
    </AppShell>
  );
}

// ── Wallet panel ────────────────────────────────────────────────────────────

interface WalletRow {
  id: string;
  publicKey: string;
  label: string;
  isWatchOnly: boolean;
  solBalance: number | null;
  tokens: Array<{ mint: string; amount: number }>;
}

interface PhantomProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString(): string } }>;
}

function WalletPanel() {
  const { data: wallets, reload } = usePoll<WalletRow[]>("/api/wallet", 30_000);
  const [importKey, setImportKey] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const connectPhantom = async () => {
    const provider = (window as unknown as { phantom?: { solana?: PhantomProvider } }).phantom
      ?.solana;
    if (!provider?.isPhantom) {
      setMsg("Phantom not detected — install the Phantom browser extension");
      return;
    }
    try {
      const { publicKey } = await provider.connect();
      const res = await fetch("/api/wallet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "watch",
          payload: { publicKey: publicKey.toString(), label: "Phantom (watch-only)" },
        }),
      });
      setMsg(res.ok ? "Phantom connected (watch-only)" : "Failed to register wallet");
      reload();
    } catch {
      setMsg("Connection cancelled");
    }
  };

  const importWallet = async () => {
    const res = await fetch("/api/wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "import", payload: { secretKey: importKey } }),
    });
    const body = await res.json().catch(() => ({}));
    setMsg(res.ok ? "Bot wallet imported and encrypted" : (body.error ?? "Import failed"));
    if (res.ok) {
      setImportKey("");
      setShowImport(false);
      reload();
    }
  };

  return (
    <div className="card mt-6">
      <div className="stat-label mb-1">Wallets</div>
      <p className="text-xs text-slate-500 mb-4 max-w-3xl leading-relaxed">
        <strong className="text-slate-400">How wallets work here:</strong> Phantom cannot
        auto-sign transactions — every Phantom transaction requires a manual click, which makes
        it unusable for a bot. Connect Phantom below to <em>view</em> its balances, and fund a
        small <em>dedicated bot wallet</em> (create a fresh one in Phantom, export its private
        key, import it here) for automated trading. The key is encrypted with AES-256-GCM
        before storage and only decrypted in the engine at signing time. Never import your main
        wallet — fund the bot wallet only with what you can afford to lose.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <button onClick={connectPhantom} className="btn-primary">
          Connect Phantom (watch-only)
        </button>
        <button onClick={() => setShowImport(!showImport)} className="btn-ghost">
          Import bot wallet
        </button>
      </div>

      {showImport && (
        <div className="mb-4 p-3 bg-surface-overlay rounded-lg border border-warn/30">
          <label className="text-xs text-warn block mb-2">
            ⚠ Paste the private key of a DEDICATED bot wallet (base58, Phantom export format).
            It is sent over HTTPS once, encrypted, and never displayed again.
          </label>
          <div className="flex gap-2">
            <input
              className="input"
              type="password"
              value={importKey}
              onChange={(e) => setImportKey(e.target.value)}
              placeholder="base58 secret key"
              autoComplete="off"
            />
            <button onClick={importWallet} className="btn-primary shrink-0" disabled={importKey.length < 64}>
              Encrypt & store
            </button>
          </div>
        </div>
      )}

      {msg && <p className="text-xs text-slate-400 mb-3">{msg}</p>}

      <div className="space-y-2">
        {(wallets ?? []).map((w) => (
          <div
            key={w.id}
            className="flex items-center justify-between gap-3 p-3 bg-surface-overlay rounded-lg flex-wrap"
          >
            <div>
              <div className="text-sm font-mono">{shortMint(w.publicKey)}</div>
              <div className="text-xs text-slate-500">
                {w.label} · {w.isWatchOnly ? "watch-only" : "trading enabled"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-mono">
                {w.solBalance != null ? `${w.solBalance.toFixed(4)} SOL` : "balance unavailable"}
              </div>
              {w.tokens.length > 0 && (
                <div className="text-xs text-slate-500">{w.tokens.length} token(s)</div>
              )}
            </div>
          </div>
        ))}
        {(!wallets || wallets.length === 0) && (
          <p className="text-sm text-slate-600">No wallets connected yet</p>
        )}
      </div>
    </div>
  );
}
