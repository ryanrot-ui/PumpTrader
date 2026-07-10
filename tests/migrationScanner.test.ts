import { describe, expect, it } from "vitest";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  extractMigration,
  PUMPSWAP_AMM,
  RAYDIUM_AMM_V4,
} from "../src/engine/scanner/migrationScanner";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_MINT = "GqUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jpump"; // vanity suffix
const LP_MINT = "LP1111111111111111111111111111111111111111";

const pool = PublicKey.unique();
const other = PublicKey.unique();

/** Minimal parsed-tx shape: program instructions + post token balances. */
function fakeTx(opts: {
  topProgram?: PublicKey;
  topAccounts?: PublicKey[];
  innerProgram?: PublicKey;
  innerAccounts?: PublicKey[];
  mints?: string[];
}): ParsedTransactionWithMeta {
  const top = opts.topProgram
    ? [{ programId: opts.topProgram, accounts: opts.topAccounts ?? [] }]
    : [];
  const inner = opts.innerProgram
    ? [{ instructions: [{ programId: opts.innerProgram, accounts: opts.innerAccounts ?? [] }] }]
    : [];
  return {
    blockTime: 1_760_000_000,
    transaction: { message: { instructions: top } },
    meta: {
      innerInstructions: inner,
      postTokenBalances: (opts.mints ?? []).map((mint) => ({ mint })),
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("extractMigration", () => {
  it("detects a PumpSwap-era graduation (migrate → inner create_pool)", () => {
    // Real shape: top-level pump-program `migrate`, CPI into PumpSwap create_pool.
    const tx = fakeTx({
      topProgram: other, // the pump bonding-curve program (not an AMM)
      innerProgram: PUMPSWAP_AMM,
      innerAccounts: [pool, other, other, other],
      mints: [WSOL, TOKEN_MINT, LP_MINT],
    });
    const ev = extractMigration(tx, "sig1");
    expect(ev).not.toBeNull();
    expect(ev!.mint).toBe(TOKEN_MINT); // prefers the …pump vanity mint over the LP mint
    expect(ev!.poolAddress).toBe(pool.toBase58()); // create_pool account 0
    expect(ev!.migratedAt.getTime()).toBe(1_760_000_000_000);
  });

  it("still detects a legacy Raydium migration (pool at account index 4)", () => {
    const tx = fakeTx({
      topProgram: RAYDIUM_AMM_V4,
      topAccounts: [other, other, other, other, pool, other],
      mints: [WSOL, TOKEN_MINT],
    });
    const ev = extractMigration(tx, "sig2");
    expect(ev).not.toBeNull();
    expect(ev!.mint).toBe(TOKEN_MINT);
    expect(ev!.poolAddress).toBe(pool.toBase58());
  });

  it("ignores authority transactions that touch neither AMM", () => {
    const tx = fakeTx({ topProgram: other, mints: [WSOL, TOKEN_MINT] });
    expect(extractMigration(tx, "sig3")).toBeNull();
  });

  it("ignores AMM transactions with no non-WSOL mint", () => {
    const tx = fakeTx({ innerProgram: PUMPSWAP_AMM, innerAccounts: [pool], mints: [WSOL] });
    expect(extractMigration(tx, "sig4")).toBeNull();
  });

  it("falls back to the first non-WSOL mint when no vanity suffix is present", () => {
    const plain = "P1ainMintWithoutVanitySuffix11111111111111";
    const tx = fakeTx({
      innerProgram: PUMPSWAP_AMM,
      innerAccounts: [pool],
      mints: [WSOL, plain],
    });
    expect(extractMigration(tx, "sig5")!.mint).toBe(plain);
  });
});
