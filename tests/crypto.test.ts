import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, safeEqual } from "@/lib/crypto";

beforeAll(() => {
  process.env.WALLET_ENCRYPTION_KEY = "a".repeat(64);
});

describe("wallet key encryption", () => {
  it("round-trips a secret", () => {
    const secret = "4wBqpZM9msxygzsdeLPM6ZHWzHfHtLf5rK8Ah7jArQ1sTest";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces a different ciphertext every time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const encrypted = encryptSecret("secret");
    const [iv, tag, data] = encrypted.split(":");
    const flipped = data.slice(0, -2) + (data.endsWith("00") ? "11" : "00");
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it("refuses to run without a proper key", () => {
    const saved = process.env.WALLET_ENCRYPTION_KEY;
    process.env.WALLET_ENCRYPTION_KEY = "tooshort";
    expect(() => encryptSecret("x")).toThrow(/WALLET_ENCRYPTION_KEY/);
    process.env.WALLET_ENCRYPTION_KEY = saved;
  });

  it("compares strings in constant time semantics", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
