"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { AppShell } from "@/components/layout/AppShell";
import { WALLET_ERROR_EVENT } from "@/components/wallet/WalletProviders";
import { TradingModeToggle } from "@/components/TradingModeToggle";
import { usePoll } from "@/components/usePoll";
import { shortMint, timeAgo } from "@/components/ui";
import { SCALPING_PRESET, detectPreset } from "@/lib/presets";

type SettingsForm = Record<string, unknown>;

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
      { key: "maxLiquiditySol", label: "Maximum liquidity (SOL)", nullable: true, hint: "empty = no ceiling" },
      { key: "minMarketCapUsd", label: "Minimum market cap (USD)" },
      { key: "maxMarketCapUsd", label: "Maximum market cap (USD)" },
      { key: "minHolders", label: "Minimum holders" },
      { key: "minVolume5mUsd", label: "Minimum 5m volume (USD)" },
      { key: "minBuyPressure", label: "Minimum buy pressure", hint: "buy/sell ratio, e.g. 1.2" },
      { key: "maxWhalePct", label: "Max whale holding (%)", hint: "largest single holder" },
      { key: "maxDevPct", label: "Max developer holding (%)" },
    ],
  },
  {
    title: "Selling",
    fields: [
      { key: "takeProfitPct", label: "Take profit (%)", hint: "scalping default 12 — small wins, taken often" },
      { key: "stopLossPct", label: "Stop loss (%)", hint: "scalping default 6 — cut losers immediately" },
      { key: "trailingStopPct", label: "Trailing stop (%)", nullable: true, hint: "locks gains once in profit; empty = disabled" },
      { key: "maxHoldMinutes", label: "Time-based exit (minutes)", nullable: true, hint: "scalping default 10; empty = disabled" },
      { key: "sellPortionPct", label: "Sell portion at TP (%)" },
    ],
  },
  {
    title: "Momentum exits (scalping)",
    fields: [
      {
        key: "exitMinBuySellRatio",
        label: "Exit when 5m buy/sell ratio falls below",
        nullable: true,
        hint: "buy pressure faded → leave before the dump; empty = disabled",
      },
      {
        key: "exitVolumeFadePct",
        label: "Exit when 5m volume fades by (%)",
        nullable: true,
        hint: "vs volume at entry; empty = disabled",
      },
      {
        key: "exitLiquidityDropPct",
        label: "Emergency exit on liquidity drop (%)",
        hint: "rug protection — exits everything when the pool drains this much",
      },
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
  {
    title: "Execution",
    fields: [
      { key: "maxSlippageBps", label: "Max slippage (bps)", hint: "100 bps = 1%" },
      { key: "priorityFeeLamports", label: "Priority fee (lamports)", nullable: true, hint: "empty = automatic" },
      { key: "retryCount", label: "Swap retry attempts", hint: "only retries provably-dropped swaps" },
      { key: "scannerIntervalSec", label: "Scanner interval (seconds)", hint: "watchlist re-evaluation cadence" },
    ],
  },
  {
    title: "Narrative intelligence",
    fields: [
      { key: "minNarrativeScore", label: "Min narrative score (0–100)", nullable: true, hint: "social momentum gate; empty = disabled" },
      { key: "minMemeScore", label: "Min meme strength (0–100)", nullable: true, hint: "meme quality gate; empty = disabled" },
      { key: "maxRugRiskScore", label: "Max rug risk (0–100)", nullable: true, hint: "evidence-based estimate, not a guarantee; empty = disabled" },
    ],
  },
];

const NARRATIVE_EXIT_MODES = [
  { value: "off", label: "Off", hint: "ignore narrative changes after entry" },
  { value: "alert", label: "Alert", hint: "log + notify when narrative deteriorates" },
  { value: "execute", label: "Execute", hint: "market-exit when narrative deteriorates" },
] as const;

export default function SettingsPage() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presetState, setPresetState] = useState<"idle" | "applying" | "done">("idle");

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

      {/* Paper / Live switch — server-enforced confirmation before live mode */}
      <div className="max-w-md mb-4">
        <TradingModeToggle />
      </div>

      {form && (
        <>
          <div className="grid lg:grid-cols-2 xl:grid-cols-4 gap-4">
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
                        value={form[f.key] === null || form[f.key] === undefined ? "" : String(form[f.key])}
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

          {/* Narrative exit mode */}
          <div className="card mt-4 max-w-xl">
            <div className="stat-label mb-1">Narrative exit strategy</div>
            <p className="text-[11px] text-slate-600 mb-2">
              What to do when an OPEN position&apos;s narrative deteriorates (mention velocity
              collapses, sentiment flips, rug risk spikes).
            </p>
            <div className="flex gap-2 flex-wrap">
              {NARRATIVE_EXIT_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setForm({ ...form, narrativeExitMode: m.value })}
                  title={m.hint}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    form.narrativeExitMode === m.value
                      ? "bg-accent/20 border-accent/50 text-accent"
                      : "bg-surface-overlay border-surface-border text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-slate-600 mt-2">
              {NARRATIVE_EXIT_MODES.find((m) => m.value === form.narrativeExitMode)?.hint}
            </p>
          </div>

          <div className="flex items-center gap-3 mt-4 flex-wrap">
            <button onClick={save} className="btn-primary px-6 py-2">
              Save settings
            </button>
            <button
              disabled={presetState === "applying"}
              onClick={async () => {
                if (!form) return;
                setError(null);
                setPresetState("applying");
                // Apply AND save in one action: the form updates immediately
                // and the same values are persisted, so the click always has
                // a visible, confirmed effect.
                const next = { ...form, ...SCALPING_PRESET };
                setForm(next);
                const res = await fetch("/api/settings", {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(next),
                }).catch(() => null);
                if (!res?.ok) {
                  const body = await res?.json().catch(() => ({}));
                  setError((body as { error?: string })?.error ?? "Failed to save the preset — check the connection and try again");
                  setPresetState("idle");
                  return;
                }
                setPresetState("done");
                setTimeout(() => setPresetState("idle"), 5000);
              }}
              className="btn-ghost px-4 py-2 text-sm disabled:opacity-50"
              title="Applies AND saves the momentum-scalping strategy: TP +12%, SL -6%, 5% trail, 10-min max hold, exit on buy-pressure/volume fade, momentum-weighted scoring."
            >
              {presetState === "applying" ? "Applying preset…" : "Apply scalping preset"}
            </button>
            {presetState === "done" && (
              <span className="text-profit text-sm">✓ Scalping preset saved — engine reloading</span>
            )}
            {detectPreset(form as Record<string, unknown>) === "momentum-scalping" && presetState === "idle" && (
              <span className="text-xs px-2 py-0.5 rounded bg-profit/10 text-profit">
                Scalping preset active
              </span>
            )}
            {saved && <span className="text-profit text-sm">✓ Saved — engine reloading</span>}
            {error && <span className="text-loss text-sm">{error}</span>}
          </div>

          <DangerZone />
        </>
      )}

      <SecurityPanel />
      <WalletPanel />
    </AppShell>
  );
}

// ── Security (2FA) ──────────────────────────────────────────────────────────

function SecurityPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/2fa")
      .then((r) => r.json())
      .then((d) => setEnabled(Boolean(d.enabled)))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const call = async (body: object) => {
    const res = await fetch("/api/2fa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(data.error ?? "Request failed");
      return null;
    }
    setMsg(null);
    return data;
  };

  return (
    <div className="card mt-6">
      <div className="stat-label mb-1">Security — two-factor authentication</div>
      <p className="text-xs text-slate-500 mb-3">
        TOTP 2FA (Google Authenticator, Authy, 1Password…). Strongly recommended before
        enabling live trading.
      </p>

      {enabled === null ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-profit text-sm">✓ 2FA is enabled</span>
          <input
            className="input !w-32"
            placeholder="123456"
            value={code}
            maxLength={6}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            className="btn-ghost text-xs"
            onClick={async () => {
              const r = await call({ action: "disable", code });
              if (r) {
                setEnabled(false);
                setCode("");
              }
            }}
          >
            Disable 2FA
          </button>
        </div>
      ) : setup ? (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            Add this secret to your authenticator app, then confirm with a code:
          </p>
          <div className="font-mono text-sm bg-surface-overlay rounded p-2 break-all">{setup.secret}</div>
          <div className="font-mono text-[10px] text-slate-500 break-all">{setup.uri}</div>
          <div className="flex gap-2">
            <input
              className="input !w-32"
              placeholder="123456"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              className="btn-primary text-xs"
              onClick={async () => {
                const r = await call({ action: "confirm", code });
                if (r) {
                  setEnabled(true);
                  setSetup(null);
                  setCode("");
                }
              }}
            >
              Confirm & enable
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn-primary text-xs"
          onClick={async () => {
            const r = await call({ action: "setup" });
            if (r) setSetup(r as { secret: string; uri: string });
          }}
        >
          Enable 2FA
        </button>
      )}
      {msg && <p className="text-loss text-xs mt-2">{msg}</p>}
    </div>
  );
}

// ── Wallets (official Solana Wallet Adapter) ────────────────────────────────

interface WalletRow {
  id: string;
  publicKey: string;
  label: string;
  isWatchOnly: boolean;
  solBalance: number | null;
  tokens: Array<{ mint: string; amount: number }>;
  recentTransactions: Array<{ signature: string; at: number | null; err: boolean }>;
}

function WalletPanel() {
  const { publicKey, connected, connect, disconnect, wallet, select, wallets, signMessage } =
    useWallet();
  const { data: walletRows, reload } = usePoll<WalletRow[]>("/api/wallet", 30_000);
  const [importKey, setImportKey] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const verifyingRef = useRef<string | null>(null);

  // Wallet errors surface here (the adapter otherwise deselects silently):
  // rejected prompts, locked wallet, network failures.
  useEffect(() => {
    const onWalletError = (e: Event) => {
      const { name } = (e as CustomEvent<{ name: string; message: string }>).detail;
      if (name === "WalletConnectionError") {
        setMsg("Connection cancelled — the Phantom request was rejected");
      } else if (name === "WalletNotReadyError") {
        setMsg("Phantom not detected — install the Phantom browser extension");
      } else if (name !== "WalletDisconnectedError") {
        setMsg("Wallet error — check that Phantom is unlocked and try again");
      }
    };
    window.addEventListener(WALLET_ERROR_EVENT, onWalletError);
    return () => window.removeEventListener(WALLET_ERROR_EVENT, onWalletError);
  }, []);

  // Wallet-change detection: whenever Phantom connects or switches accounts,
  // link the new address to this account — after the wallet proves ownership
  // by signing a verification message (free, no transaction).
  useEffect(() => {
    if (!publicKey || !signMessage) return;
    const address = publicKey.toBase58();
    if (verifyingRef.current === address) return; // already verifying this key
    if (walletRows?.some((w) => w.publicKey === address)) return; // already linked
    verifyingRef.current = address;

    void (async () => {
      try {
        const { message } = (await fetch("/api/wallet/verify-message").then((r) => r.json())) as {
          message: string;
        };
        // Phantom prompts here; the user can decline (wallet stays connected
        // but is not linked to the account).
        const signature = await signMessage(new TextEncoder().encode(message));
        const res = await fetch("/api/wallet", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "watch",
            payload: {
              publicKey: address,
              label: "Phantom (watch-only)",
              message,
              signature: bs58.encode(signature),
            },
          }),
        });
        const body = await res.json().catch(() => ({}));
        setMsg(
          res.ok
            ? "Phantom connected and ownership verified (watch-only; mainnet)"
            : (body.error ?? "Wallet verification failed")
        );
        if (res.ok) reload();
      } catch {
        setMsg("Wallet verification declined — Phantom is connected but not linked to your account");
      } finally {
        verifyingRef.current = null;
      }
    })();
  }, [publicKey, signMessage, walletRows, reload]);

  const connectPhantom = async () => {
    try {
      if (!wallet) {
        const phantom = wallets.find((w) => w.adapter.name === "Phantom");
        if (!phantom || phantom.readyState !== WalletReadyState.Installed) {
          setMsg("Phantom not detected — install the Phantom browser extension");
          return;
        }
        // select() updates context asynchronously; the provider's autoConnect
        // completes the connection. Calling connect() in the same tick would
        // throw WalletNotSelectedError.
        select(phantom.adapter.name);
        setMsg("Connecting to Phantom…");
        return;
      }
      await connect();
      setMsg("Phantom connected — approve the verification signature to link it");
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
        <strong className="text-slate-400">Two modes.</strong>{" "}
        <strong className="text-slate-400">Manual:</strong> connect Phantom (official Solana
        Wallet Adapter) and approve each trade in the extension — no key ever leaves Phantom.{" "}
        <strong className="text-slate-400">Auto:</strong> the engine trades with a{" "}
        <em>dedicated bot wallet</em> whose key is AES-256-GCM encrypted at rest and decrypted
        only at signing time, server-side. Never import your main wallet — fund the bot wallet
        only with what you can afford to lose. Mainnet only.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {connected && publicKey ? (
          <>
            <span className="btn-ghost text-xs cursor-default">
              ◈ {shortMint(publicKey.toBase58())} connected
            </span>
            <button onClick={() => void disconnect()} className="btn-ghost text-xs">
              Disconnect
            </button>
          </>
        ) : (
          <button onClick={connectPhantom} className="btn-primary">
            Connect Phantom (watch-only)
          </button>
        )}
        <button onClick={() => setShowImport(!showImport)} className="btn-ghost">
          Import bot wallet
        </button>
      </div>

      {showImport && (
        <div className="mb-4 p-3 bg-surface-overlay rounded-lg border border-warn/30">
          <label className="text-xs text-warn block mb-2">
            ⚠ Paste the private key of a DEDICATED bot wallet (base58, Phantom export format).
            It is sent over HTTPS once, encrypted, and never displayed again. NEVER paste a
            seed phrase.
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
        {(walletRows ?? []).map((w) => (
          <div key={w.id} className="p-3 bg-surface-overlay rounded-lg">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-mono">
                  {shortMint(w.publicKey)}
                  <a
                    href={`https://solscan.io/account/${w.publicKey}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent text-xs ml-2 hover:underline"
                  >
                    explorer ↗
                  </a>
                </div>
                <div className="text-xs text-slate-500">
                  {w.label} · {w.isWatchOnly ? "watch-only" : "auto-trading enabled"}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-mono">
                  {w.solBalance != null ? `${w.solBalance.toFixed(4)} SOL` : "balance unavailable"}
                </div>
                {w.tokens.length > 0 && (
                  <div className="text-xs text-slate-500">{w.tokens.length} SPL token(s)</div>
                )}
              </div>
            </div>
            {w.recentTransactions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-surface-border/50">
                <div className="text-[10px] text-slate-600 mb-1">Recent transactions</div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {w.recentTransactions.slice(0, 5).map((t) => (
                    <a
                      key={t.signature}
                      href={`https://solscan.io/tx/${t.signature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`text-[10px] font-mono hover:underline ${t.err ? "text-loss" : "text-slate-400"}`}
                    >
                      {t.signature.slice(0, 8)}… {t.at ? timeAgo(new Date(t.at)) : ""}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        {(!walletRows || walletRows.length === 0) && (
          <p className="text-sm text-slate-600">No wallets connected yet</p>
        )}
      </div>

      <ManualTradePanel />
    </div>
  );
}

// ── Danger zone ──────────────────────────────────────────────────────────────

function DangerZone() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reset = async () => {
    if (
      !window.confirm(
        "Reset dashboard statistics to zero?\n\nThis permanently deletes all PAPER trades, PAPER positions, and the daily counters (PnL, win rate, scanned/bought/rejected).\n\nLive trades, detected tokens, settings, and wallets are NOT touched."
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (res?.ok) {
      const d = (body as { deleted?: { paperTrades: number; paperPositions: number } }).deleted;
      setMsg(`✓ Reset complete — deleted ${d?.paperTrades ?? 0} paper trades and ${d?.paperPositions ?? 0} paper positions. The dashboard is back to zero.`);
    } else {
      setMsg((body as { error?: string })?.error ?? "Reset failed — try again");
    }
    setBusy(false);
  };

  return (
    <div className="card mt-4 max-w-xl border-loss/30">
      <div className="stat-label mb-1 text-loss">Danger zone</div>
      <p className="text-[11px] text-slate-600 mb-2">
        Start fresh after changing strategy: wipes paper-trading history and the dashboard
        counters so the stats reflect only the current configuration. Live trade records are
        never deleted.
      </p>
      <button onClick={reset} disabled={busy} className="btn-ghost text-sm !border-loss/40 !text-loss disabled:opacity-50">
        {busy ? "Resetting…" : "Reset dashboard statistics"}
      </button>
      {msg && <p className="text-xs mt-2 text-slate-400">{msg}</p>}
    </div>
  );
}

// ── Manual trading via Phantom approval ─────────────────────────────────────

function ManualTradePanel() {
  const { publicKey, signTransaction, connected } = useWallet();
  const [mint, setMint] = useState("");
  const [amount, setAmount] = useState("0.05");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const trade = async (side: "buy" | "sell") => {
    if (!publicKey || !signTransaction) return;
    setBusy(true);
    setMsg(null);
    try {
      const build = await fetch("/api/manual-trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletPublicKey: publicKey.toBase58(),
          mint: mint.trim(),
          side,
          amount: parseFloat(amount),
          slippageBps: 300,
        }),
      });
      const buildBody = await build.json();
      if (!build.ok) throw new Error(buildBody.error ?? "Failed to build transaction");

      // Phantom shows its approval popup here — the user signs, we never see the key.
      const tx = VersionedTransaction.deserialize(
        Uint8Array.from(atob(buildBody.transaction), (c) => c.charCodeAt(0))
      );
      const signed = await signTransaction(tx);
      const signedB64 = btoa(String.fromCharCode(...signed.serialize()));

      const submit = await fetch("/api/manual-trade/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only the signed bytes: the server records mint/side/amount from its
        // own build registration, not from anything the client claims.
        body: JSON.stringify({ signedTransaction: signedB64 }),
      });
      const submitBody = await submit.json();
      if (!submit.ok) throw new Error(submitBody.error ?? "Submission failed");
      setMsg(`✓ Executed: ${submitBody.signature}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-surface-border">
      <div className="stat-label mb-1">Manual trade (Phantom approval)</div>
      <p className="text-[10px] text-slate-600 mb-2">
        Builds a Jupiter swap for your connected Phantom wallet — the extension asks you to
        approve every transaction. Buy amount is SOL; sell amount is token base units.
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <input
          className="input !w-96 max-w-full"
          placeholder="token mint address"
          value={mint}
          onChange={(e) => setMint(e.target.value)}
        />
        <input
          className="input !w-28"
          type="number"
          step="any"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button
          className="btn-primary text-xs"
          disabled={!connected || busy || mint.trim().length < 32}
          onClick={() => void trade("buy")}
        >
          {busy ? "…" : "Buy"}
        </button>
        <button
          className="btn-danger text-xs"
          disabled={!connected || busy || mint.trim().length < 32}
          onClick={() => void trade("sell")}
        >
          {busy ? "…" : "Sell"}
        </button>
      </div>
      {!connected && <p className="text-[10px] text-slate-600 mt-1">Connect Phantom to trade manually.</p>}
      {msg && <p className="text-xs text-slate-400 mt-2 break-all">{msg}</p>}
    </div>
  );
}
