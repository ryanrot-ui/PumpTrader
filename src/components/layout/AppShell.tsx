"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { usePoll } from "../usePoll";
import { WalletProviders } from "../wallet/WalletProviders";

const NAV = [
  { href: "/", label: "Dashboard", icon: "◧" },
  { href: "/scanner", label: "Scanner", icon: "◉" },
  { href: "/intelligence", label: "Intelligence", icon: "◈" },
  { href: "/positions", label: "Positions", icon: "⇅" },
  { href: "/logs", label: "Logs", icon: "≡" },
  { href: "/diagnostics", label: "Diagnostics", icon: "✚" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

const IDLE_LOGOUT_MS = 30 * 60_000; // auto-logout after 30 min of inactivity

interface BotStatus {
  status: string;
  engineAlive: boolean;
  readOnly: boolean;
  mode: "auto" | "manual";
  paperTrading: boolean;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { data: bot, reload } = usePoll<BotStatus>("/api/bot", 5000);
  useIdleLogout();

  const control = async (action: string) => {
    await fetch("/api/bot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setTimeout(reload, 300);
  };

  const running = bot?.status === "running" && bot?.mode === "auto";
  const emergency = bot?.status === "emergency_stopped";

  const modeLabel = emergency
    ? "EMERGENCY STOP"
    : bot?.readOnly
      ? "READ-ONLY"
      : bot?.mode === "auto"
        ? bot.paperTrading
          ? "AUTO · paper"
          : "AUTO · LIVE"
        : "MANUAL · Phantom approval";
  const modeTone = emergency
    ? "text-loss"
    : bot?.readOnly
      ? "text-warn"
      : bot?.mode === "auto" && !bot.paperTrading
        ? "text-accent"
        : "text-slate-400";

  return (
    <WalletProviders>
      <div className="min-h-screen flex">
        {/* Sidebar */}
        <aside
          className={`fixed lg:static inset-y-0 left-0 z-40 w-56 bg-surface-raised border-r border-surface-border
            flex flex-col transition-transform lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="p-4 border-b border-surface-border">
            <div className="font-bold text-lg tracking-tight">
              Pump<span className="text-accent">Trader</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">Migration scanner · Raydium</div>
          </div>
          <nav className="flex-1 p-2 space-y-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  pathname === n.href
                    ? "bg-accent/15 text-accent"
                    : "text-slate-400 hover:text-slate-200 hover:bg-surface-overlay"
                }`}
              >
                <span className="w-4 text-center">{n.icon}</span>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="p-3 border-t border-surface-border space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  emergency
                    ? "bg-loss animate-pulse-fast"
                    : running && bot?.engineAlive
                      ? "bg-profit animate-pulse"
                      : "bg-slate-600"
                }`}
              />
              <span className={modeTone}>{modeLabel}</span>
            </div>
            {running && !bot?.engineAlive && (
              <div className="text-[10px] text-warn">engine worker offline</div>
            )}
            <div className="flex gap-1.5">
              {emergency ? (
                <button onClick={() => control("resume")} className="btn-ghost flex-1 text-xs">
                  Resume
                </button>
              ) : (
                <>
                  <button
                    onClick={() => control(running ? "stop" : "start")}
                    className={`flex-1 text-xs ${running ? "btn-ghost" : "btn-primary"}`}
                  >
                    {running ? "Stop auto" : "Start auto"}
                  </button>
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          "EMERGENCY STOP: halt all buying AND market-sell every open position immediately. Continue?"
                        )
                      ) {
                        void control("emergency_stop");
                      }
                    }}
                    className="btn-danger text-xs"
                    title="Halt buying and exit every open position immediately (asks for confirmation)"
                  >
                    ■ Kill
                  </button>
                </>
              )}
            </div>
            <button
              onClick={() => control(bot?.readOnly ? "read_only_off" : "read_only_on")}
              className="w-full btn-ghost text-xs"
              title="Read-only: engine scans and scores but executes nothing"
            >
              {bot?.readOnly ? "Exit read-only mode" : "Enter read-only mode"}
            </button>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="w-full text-left text-xs text-slate-500 hover:text-slate-300 px-1"
            >
              Sign out
            </button>
            <p className="text-[9px] text-slate-600 leading-snug px-1">
              High-risk experimental software — not financial advice, no profit
              guarantees. Paper trades are simulations.
            </p>
          </div>
        </aside>

        {/* Mobile scrim */}
        {open && (
          <div className="fixed inset-0 bg-black/60 z-30 lg:hidden" onClick={() => setOpen(false)} />
        )}

        {/* Main */}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="lg:hidden sticky top-0 z-20 flex items-center gap-3 px-4 h-14 bg-surface-raised border-b border-surface-border">
            <button onClick={() => setOpen(true)} className="text-xl">
              ☰
            </button>
            <span className="font-bold">
              Pump<span className="text-accent">Trader</span>
            </span>
            <span className={`ml-auto text-[10px] ${modeTone}`}>{modeLabel}</span>
          </header>
          <main className="flex-1 p-4 lg:p-6 max-w-[1600px] w-full mx-auto">{children}</main>
        </div>
      </div>
    </WalletProviders>
  );
}

/** Auto sign-out after 30 minutes without pointer/keyboard activity. */
function useIdleLogout() {
  const timer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void signOut({ callbackUrl: "/login" }), IDLE_LOGOUT_MS);
    };
    const events = ["mousemove", "keydown", "click", "touchstart", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, []);
}
