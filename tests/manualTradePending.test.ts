import { describe, expect, it } from "vitest";
import {
  consumeBuiltTx,
  registerBuiltTx,
  txMessageHash,
} from "../src/lib/manualTradePending";

const msg = (fill: number) => new Uint8Array(64).fill(fill);

describe("manual-trade build↔submit binding", () => {
  it("consumes a registered build exactly once (duplicate-submit protection)", () => {
    const hash = txMessageHash(msg(1));
    registerBuiltTx(hash, { userId: "u1", mint: "MintA", side: "buy", amountSol: 0.05 });
    expect(consumeBuiltTx(hash, "u1")).toEqual({ mint: "MintA", side: "buy", amountSol: 0.05 });
    expect(consumeBuiltTx(hash, "u1")).toBeNull(); // second submit blocked
  });

  it("rejects transactions the server never built (no open relay)", () => {
    expect(consumeBuiltTx(txMessageHash(msg(2)), "u1")).toBeNull();
  });

  it("rejects a build registered for another user", () => {
    const hash = txMessageHash(msg(3));
    registerBuiltTx(hash, { userId: "u1", mint: "MintA", side: "sell", amountSol: 0.1 });
    expect(consumeBuiltTx(hash, "attacker")).toBeNull();
  });

  it("hash is stable for identical messages and distinct otherwise", () => {
    expect(txMessageHash(msg(4))).toBe(txMessageHash(msg(4)));
    expect(txMessageHash(msg(4))).not.toBe(txMessageHash(msg(5)));
  });
});
