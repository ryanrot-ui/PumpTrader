import { describe, expect, it, vi } from "vitest";

// In-memory stand-in for the PendingManualTrade table with the same atomic
// semantics the code relies on (upsert; delete throws when the row is gone).
interface Row {
  hash: string;
  userId: string;
  mint: string;
  side: string;
  expiresAt: Date;
}
const table = new Map<string, Row>();

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    pendingManualTrade: {
      upsert: async ({ where, create }: { where: { hash: string }; create: Row }) => {
        table.set(where.hash, { ...create });
        return create;
      },
      delete: async ({ where }: { where: { hash: string } }) => {
        const row = table.get(where.hash);
        if (!row) throw new Error("P2025: record not found");
        table.delete(where.hash);
        return row;
      },
      deleteMany: async ({ where }: { where: { expiresAt: { lte: Date } } }) => {
        let count = 0;
        for (const [k, v] of table) {
          if (v.expiresAt <= where.expiresAt.lte) {
            table.delete(k);
            count++;
          }
        }
        return { count };
      },
    },
  },
}));

const { consumeBuiltTx, registerBuiltTx, txMessageHash } = await import(
  "../src/lib/manualTradePending"
);

const msg = (fill: number) => new Uint8Array(64).fill(fill);

describe("manual-trade build↔submit binding", () => {
  it("consumes a registered build exactly once (duplicate-submit protection)", async () => {
    const hash = txMessageHash(msg(1));
    await registerBuiltTx(hash, { userId: "u1", mint: "MintA", side: "buy" });
    expect(await consumeBuiltTx(hash, "u1")).toEqual({ mint: "MintA", side: "buy" });
    expect(await consumeBuiltTx(hash, "u1")).toBeNull(); // second submit blocked
  });

  it("rejects transactions the server never built (no open relay)", async () => {
    expect(await consumeBuiltTx(txMessageHash(msg(2)), "u1")).toBeNull();
  });

  it("rejects a build registered for another user", async () => {
    const hash = txMessageHash(msg(3));
    await registerBuiltTx(hash, { userId: "u1", mint: "MintA", side: "sell" });
    expect(await consumeBuiltTx(hash, "attacker")).toBeNull();
  });

  it("rejects an expired build", async () => {
    const hash = txMessageHash(msg(6));
    await registerBuiltTx(hash, { userId: "u1", mint: "MintA", side: "buy" });
    const row = table.get(hash)!;
    row.expiresAt = new Date(Date.now() - 1_000);
    expect(await consumeBuiltTx(hash, "u1")).toBeNull();
  });

  it("hash is stable for identical messages and distinct otherwise", () => {
    expect(txMessageHash(msg(4))).toBe(txMessageHash(msg(4)));
    expect(txMessageHash(msg(4))).not.toBe(txMessageHash(msg(5)));
  });
});
