import { describe, expect, it } from "vitest";
import { clearWindow, incrementWindow, rateLimit, readWindow } from "../src/lib/rateLimit";

// REDIS_URL is unset in the test environment, so these exercise the
// in-memory fallback — the path production uses when Redis is not configured.
describe("windowed counters (in-memory fallback)", () => {
  it("increments and reads within a window", async () => {
    const key = `test:${Math.random()}`;
    expect(await incrementWindow(key, 60)).toBe(1);
    expect(await incrementWindow(key, 60)).toBe(2);
    expect(await readWindow(key)).toBe(2);
  });

  it("clears counters", async () => {
    const key = `test:${Math.random()}`;
    await incrementWindow(key, 60);
    await clearWindow(key);
    expect(await readWindow(key)).toBe(0);
  });

  it("rate limits after the threshold", async () => {
    const key = `rl-test:${Math.random()}`;
    expect(await rateLimit(key, 2, 60)).toBe(true);
    expect(await rateLimit(key, 2, 60)).toBe(true);
    expect(await rateLimit(key, 2, 60)).toBe(false);
  });
});
