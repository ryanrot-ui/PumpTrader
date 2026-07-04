"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Registration failed");
      setBusy(false);
      return;
    }
    await signIn("credentials", { email, password, redirect: false });
    router.push("/");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold">
            Pump<span className="text-accent">Trader</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">Create your account</p>
        </div>
        <form onSubmit={submit} className="card space-y-4">
          <div>
            <label className="stat-label block mb-1.5">Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="stat-label block mb-1.5">Password (min 10 chars)</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={10}
              autoComplete="new-password"
            />
          </div>
          {error && <p className="text-loss text-sm">{error}</p>}
          <button className="btn-primary w-full py-2" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
          <p className="text-xs text-slate-500 text-center">
            Already registered?{" "}
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>
          </p>
        </form>
        <p className="text-[11px] text-slate-600 mt-4 text-center leading-relaxed">
          Trading newly migrated tokens is extremely high risk. This software provides
          configurable filters and risk controls — it does not and cannot guarantee profits.
          Start in paper trading mode.
        </p>
      </div>
    </div>
  );
}
