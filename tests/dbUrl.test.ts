import { describe, expect, it } from "vitest";
import { tuneDbUrl, isNeonHost, isNeonPooledUrl, neonConfigWarnings } from "../src/lib/dbUrl";

const NEON_POOLED =
  "postgresql://user:pw@ep-proud-queen-asb90gzb-pooler.c-4.eu-central-1.aws.neon.tech:5432/neondb?sslmode=require";
const NEON_DIRECT =
  "postgresql://user:pw@ep-proud-queen-asb90gzb.c-4.eu-central-1.aws.neon.tech:5432/neondb?sslmode=require";

describe("tuneDbUrl", () => {
  it("adds connect_timeout and pool_timeout defaults", () => {
    const tuned = new URL(tuneDbUrl(NEON_POOLED, {}));
    expect(tuned.searchParams.get("connect_timeout")).toBe("15");
    expect(tuned.searchParams.get("pool_timeout")).toBe("15");
    expect(tuned.searchParams.get("sslmode")).toBe("require"); // preserved
  });

  it("never overrides operator-set params", () => {
    const tuned = new URL(tuneDbUrl(`${NEON_POOLED}&connect_timeout=30`, {}));
    expect(tuned.searchParams.get("connect_timeout")).toBe("30");
  });

  it("applies DB_CONNECTION_LIMIT when set and numeric", () => {
    const tuned = new URL(tuneDbUrl(NEON_POOLED, { DB_CONNECTION_LIMIT: "5" }));
    expect(tuned.searchParams.get("connection_limit")).toBe("5");
    const untouched = new URL(tuneDbUrl(NEON_POOLED, { DB_CONNECTION_LIMIT: "not-a-number" }));
    expect(untouched.searchParams.get("connection_limit")).toBeNull();
  });

  it("leaves malformed and non-postgres URLs untouched", () => {
    expect(tuneDbUrl("not a url", {})).toBe("not a url");
    expect(tuneDbUrl("mysql://h/db", {})).toBe("mysql://h/db");
  });
});

describe("Neon host detection", () => {
  it("classifies pooled vs direct Neon hosts", () => {
    expect(isNeonHost(NEON_POOLED)).toBe(true);
    expect(isNeonPooledUrl(NEON_POOLED)).toBe(true);
    expect(isNeonPooledUrl(NEON_DIRECT)).toBe(false);
    expect(isNeonHost("postgresql://localhost:5432/db")).toBe(false);
  });
});

describe("neonConfigWarnings", () => {
  it("is silent for the correct pooled/direct pair", () => {
    expect(neonConfigWarnings(NEON_POOLED, NEON_DIRECT)).toEqual([]);
  });

  it("warns when DATABASE_URL is the direct Neon endpoint", () => {
    const w = neonConfigWarnings(NEON_DIRECT, undefined);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/POOLED/);
  });

  it("warns when DIRECT_URL is the pooled endpoint", () => {
    const w = neonConfigWarnings(NEON_POOLED, NEON_POOLED);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/direct endpoint/);
  });

  it("is silent for plain Postgres", () => {
    expect(neonConfigWarnings("postgresql://localhost/db", "postgresql://localhost/db")).toEqual([]);
  });
});
