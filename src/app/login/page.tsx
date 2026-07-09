"use client";

import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

/** Human-readable messages for NextAuth ?error= codes (OAuth callbacks land here). */
const AUTH_ERRORS: Record<string, string> = {
  AccessDenied:
    "This Google account is not authorized — Google sign-in only works for the existing administrator email.",
  OAuthCallback: "Google sign-in failed — check the OAuth redirect URI configuration.",
  OAuthSignin: "Could not start Google sign-in — check GOOGLE_CLIENT_ID/SECRET.",
  Configuration: "Authentication is misconfigured on the server — check the deployment logs.",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  // Show the Google button only when the provider is actually configured;
  // surface OAuth callback errors (?error=…) as readable messages.
  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((p: Record<string, unknown>) => setGoogleEnabled(Boolean(p?.google)))
      .catch(() => {});
    const code = searchParams.get("error");
    if (code) setError(AUTH_ERRORS[code] ?? "Sign-in failed — please try again.");
  }, [searchParams]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signIn("credentials", { email, password, totp, redirect: false });
    setBusy(false);
    if (res?.error) {
      // Distinguish "wrong password" from "the deployment is broken": when
      // the database is unreachable every login fails, and blaming the
      // credentials would send the operator down the wrong path.
      const health = await fetch("/api/healthz", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ database?: boolean }>)
        .catch(() => null);
      if (health && health.database === false) {
        setError(
          "The server cannot reach its database — check DATABASE_URL and the deployment logs."
        );
      } else {
        setError("Invalid credentials (or missing/wrong 2FA code)");
      }
    } else router.push("/");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold">
            Pump<span className="text-accent">Trader</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to your trading dashboard</p>
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
              autoComplete="email"
            />
          </div>
          <div>
            <label className="stat-label block mb-1.5">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="stat-label block mb-1.5">2FA code (if enabled)</label>
            <input
              className="input"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="123456"
              autoComplete="one-time-code"
            />
          </div>
          {error && <p className="text-loss text-sm">{error}</p>}
          <button className="btn-primary w-full py-2" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {googleEnabled && (
            <button
              type="button"
              onClick={() => signIn("google", { callbackUrl: "/" })}
              className="btn-ghost w-full py-2"
            >
              Continue with Google
            </button>
          )}
          <p className="text-xs text-slate-500 text-center">
            No account?{" "}
            <Link href="/register" className="text-accent hover:underline">
              Create one
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
