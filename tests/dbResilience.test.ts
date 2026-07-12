import { describe, expect, it } from "vitest";
import { DbResilience, isTransientDbError } from "../src/engine/db/resilience";

const p1001 = Object.assign(new Error("Can't reach database server at `host:5432`"), {
  code: "P1001",
});

describe("isTransientDbError", () => {
  it("classifies Prisma connectivity codes and messages as transient", () => {
    expect(isTransientDbError(p1001)).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("x"), { code: "P1017" }))).toBe(true);
    expect(isTransientDbError(new Error("connect ECONNREFUSED 1.2.3.4:5432"))).toBe(true);
    expect(isTransientDbError(new Error("Timed out fetching a new connection from the pool"))).toBe(true);
  });

  it("does not classify data/constraint errors as transient", () => {
    expect(isTransientDbError(Object.assign(new Error("unique constraint"), { code: "P2002" }))).toBe(false);
    expect(isTransientDbError(new Error("Invalid value for field"))).toBe(false);
  });
});

describe("DbResilience circuit breaker", () => {
  it("opens on the first failure and backs off exponentially, capped", () => {
    const db = new DbResilience();
    const t0 = 1_000_000;
    expect(db.healthy).toBe(true);

    db.recordFailure(p1001, t0);
    expect(db.healthy).toBe(false);
    expect(db.probeDue(t0 + 4_000)).toBe(false); // 5s backoff
    expect(db.probeDue(t0 + 5_001)).toBe(true);

    db.recordFailure(p1001, t0 + 5_001); // 10s
    db.recordFailure(p1001, t0 + 15_002); // 20s
    db.recordFailure(p1001, t0 + 35_003); // 40s
    db.recordFailure(p1001, t0 + 75_004); // 60s (cap)
    db.recordFailure(p1001, t0 + 135_005); // still 60s
    expect(db.retries).toBe(6);
    expect(db.probeDue(t0 + 135_005 + 59_000)).toBe(false);
    expect(db.probeDue(t0 + 135_005 + 60_001)).toBe(true);
  });

  it("queues detections deduped by mint and caps the score queue", () => {
    const db = new DbResilience();
    db.recordFailure(p1001);
    db.enqueueDetection({ mint: "MintA", poolAddress: null, migratedAt: new Date() });
    db.enqueueDetection({ mint: "MintA", poolAddress: "pool", migratedAt: new Date() });
    db.enqueueDetection({ mint: "MintB", poolAddress: null, migratedAt: new Date() });
    expect(db.queueSize).toBe(2); // MintA deduped

    for (let i = 0; i < 550; i++) {
      db.enqueueScore({
        tokenId: `t${i}`,
        mint: `m${i}`,
        at: new Date(),
        score: { total: 50, breakdown: {}, greenFlags: [], redFlags: [], critical: false },
        snapshot: {
          priceUsd: null,
          liquiditySol: null,
          marketCapUsd: null,
          volume5mUsd: null,
          holderCount: null,
          txPerMinute: null,
          buySellRatio: null,
        },
      });
    }
    expect(db.queueSize).toBe(2 + 500); // bounded — oldest 50 dropped
    expect(db.droppedWrites).toBe(50);
  });

  it("reports diagnostics through snapshot()", () => {
    const db = new DbResilience();
    const t0 = 2_000_000;
    db.recordFailure(p1001, t0);
    const snap = db.snapshot();
    expect(snap.dbStatus).toBe("down");
    expect(snap.dbConsecutiveFailures).toBe(1);
    expect(snap.dbLastFailureReason).toMatch(/Can't reach/);
    expect(snap.dbQueuedWrites).toBe(0);
  });

  it("recordSuccess on a healthy circuit is a no-op; after failures it closes it", async () => {
    const db = new DbResilience();
    await db.recordSuccess(); // healthy — nothing to flush
    expect(db.healthy).toBe(true);

    db.recordFailure(p1001);
    expect(db.healthy).toBe(false);
    await db.recordSuccess(); // closes + flush (queues empty)
    expect(db.healthy).toBe(true);
    expect(db.retries).toBe(0);
    expect(db.snapshot().dbStatus).toBe("up");
  });
});
