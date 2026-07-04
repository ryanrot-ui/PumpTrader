import { PrismaClient } from "@prisma/client";

// Reuse a single client across hot reloads in dev and across route handlers
// in prod — Prisma opens a connection pool per client.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
