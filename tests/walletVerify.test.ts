import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildVerificationMessage, verifyWalletProof } from "../src/lib/walletVerify";

const USER = "user_123";

export function makeProof(overrides: Partial<{ message: string; signer: nacl.SignKeyPair }> = {}) {
  const signer = overrides.signer ?? nacl.sign.keyPair();
  const message = overrides.message ?? buildVerificationMessage(USER, Date.now());
  const signature = nacl.sign.detached(new TextEncoder().encode(message), signer.secretKey);
  return {
    publicKey: bs58.encode(signer.publicKey),
    message,
    signature: bs58.encode(signature),
  };
}

describe("verifyWalletProof", () => {
  it("accepts a valid, fresh proof for the right account", () => {
    expect(verifyWalletProof(makeProof(), USER)).toEqual({ ok: true });
  });

  it("rejects a signature from a different wallet", () => {
    const proof = makeProof();
    proof.publicKey = bs58.encode(nacl.sign.keyPair().publicKey);
    const res = verifyWalletProof(proof, USER);
    expect(res.ok).toBe(false);
  });

  it("rejects a message issued for another account", () => {
    const proof = makeProof({ message: buildVerificationMessage("someone_else", Date.now()) });
    const res = verifyWalletProof(proof, USER);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("different account") });
  });

  it("rejects an expired message (replay protection)", () => {
    const proof = makeProof({
      message: buildVerificationMessage(USER, Date.now() - 11 * 60_000),
    });
    const res = verifyWalletProof(proof, USER);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
  });

  it("rejects a tampered message", () => {
    const proof = makeProof();
    proof.message = proof.message.replace("free", "totally free");
    const res = verifyWalletProof(proof, USER);
    expect(res.ok).toBe(false);
  });

  it("rejects malformed signatures without throwing", () => {
    const proof = makeProof();
    proof.signature = "!!!not-base58!!!";
    expect(verifyWalletProof(proof, USER).ok).toBe(false);
  });
});

describe("verifyWalletProof — malformed input robustness", () => {
  it("rejects a wrong-length (all-zero) base58 signature without throwing", () => {
    const proof = makeProof();
    proof.signature = "1".repeat(88); // decodes to 88 zero bytes — nacl would throw
    expect(verifyWalletProof(proof, "user_123").ok).toBe(false);
  });
});
