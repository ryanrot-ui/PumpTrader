import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { clearWindow, incrementWindow, readWindow } from "./rateLimit";
import { decryptSecret } from "./crypto";
import { verifyTotp } from "./totp";

/**
 * Authentication hardening:
 *  - argon2id password hashing (OWASP-recommended params); legacy bcrypt
 *    hashes still verify and are transparently re-hashed to argon2 on login
 *  - brute-force protection: max 5 failed attempts per identity+IP / 15 min
 *  - every login attempt (success or failure) is written to the audit log —
 *    never including the password
 *  - optional TOTP 2FA enforced when the account has it enabled
 *  - JWT sessions with 8h absolute expiry; HTTP-only, SameSite=lax cookies,
 *    Secure in production (NextAuth defaults + useSecureCookies)
 */

const MAX_ATTEMPTS = 5;
const WINDOW_S = 15 * 60;

export const ARGON2_OPTS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTS);
}

function audit(message: string, meta?: Record<string, unknown>) {
  void prisma.logEntry
    .create({ data: { level: "info", source: "api", message, meta: meta as object } })
    .catch(() => {});
}

async function bruteForceCheck(key: string): Promise<boolean> {
  return (await readWindow(`auth:fail:${key}`)) < MAX_ATTEMPTS;
}

async function bruteForceRecord(key: string, failed: boolean): Promise<void> {
  const bucket = `auth:fail:${key}`;
  if (failed) await incrementWindow(bucket, WINDOW_S);
  else await clearWindow(bucket);
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 }, // 8h absolute expiry
  // Secure (+ __Secure- prefixed) cookies whenever the app is served over
  // TLS — i.e. any real deployment. Cookies are always HTTP-only.
  useSecureCookies: (process.env.NEXTAUTH_URL ?? "").startsWith("https://"),
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totp: { label: "2FA code", type: "text" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials.password) return null;
        const email = credentials.email.toLowerCase().trim();
        const fwd = (req?.headers as Record<string, string> | undefined)?.["x-forwarded-for"];
        const ip = fwd ? fwd.split(",")[0].trim() : "unknown";
        const bfKey = `${email}:${ip}`;

        if (!(await bruteForceCheck(bfKey))) {
          audit(`login blocked (brute-force lockout): ${email}`, { ip });
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) {
          await bruteForceRecord(bfKey, true);
          audit(`login failed (unknown account): ${email}`, { ip });
          return null;
        }

        // Verify password: argon2 first, legacy bcrypt fallback with upgrade
        let ok = false;
        if (user.passwordHash.startsWith("$argon2")) {
          ok = await argon2Verify(user.passwordHash, credentials.password).catch(() => false);
        } else {
          ok = await bcrypt.compare(credentials.password, user.passwordHash);
          if (ok) {
            await prisma.user.update({
              where: { id: user.id },
              data: { passwordHash: await hashPassword(credentials.password) },
            });
          }
        }
        if (!ok) {
          await bruteForceRecord(bfKey, true);
          audit(`login failed (bad password): ${email}`, { ip });
          return null;
        }

        // Optional 2FA
        if (user.totpEnabled && user.totpSecret) {
          const secret = decryptSecret(user.totpSecret);
          if (!credentials.totp || !verifyTotp(secret, credentials.totp)) {
            await bruteForceRecord(bfKey, true);
            audit(`login failed (2FA): ${email}`, { ip });
            return null;
          }
        }

        await bruteForceRecord(bfKey, false);
        audit(`login success: ${email}`, { ip });
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ user, account }) {
      // Single-administrator model: Google sign-in is only accepted for the
      // already-provisioned admin email; it never creates new accounts.
      if (account?.provider === "google") {
        if (!user.email) return false;
        const existing = await prisma.user.findUnique({
          where: { email: user.email.toLowerCase() },
        });
        if (!existing) {
          audit(`google sign-in rejected (no such account): ${user.email}`);
          return false;
        }
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email.toLowerCase() },
        });
        if (dbUser) token.uid = dbUser.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.uid) {
        (session.user as { id?: string }).id = token.uid as string;
      }
      return session;
    },
  },
};
