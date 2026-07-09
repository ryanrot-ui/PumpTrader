/**
 * Content Security Policy. Everything is same-origin: no CDN scripts, no
 * external styles/fonts, no browser→RPC calls (all chain access is
 * server-side). 'unsafe-inline'/'unsafe-eval' concessions are limited to what
 * Next.js hydration and the wallet-adapter runtime require; script injection
 * from user data is already prevented by React escaping.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output: a self-contained server bundle for the Docker image
  // (Render web service). `next build` emits .next/standalone/server.js.
  output: "standalone",
  // Native addon (argon2) must not be bundled by webpack
  serverExternalPackages: ["@node-rs/argon2"],
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      ],
    },
  ],
};

export default nextConfig;
