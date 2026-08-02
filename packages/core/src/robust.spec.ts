import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAP_POLICY,
  capContributions,
  sourceWithinCap,
  type CapPolicy
} from "./robust.js";
import { ipPrefix, sourceHash, utcDay } from "./source.js";
import type { AssignmentRecord } from "./state.js";

function rec(
  i: number,
  srcHash: string | null,
  overrides: Partial<AssignmentRecord> = {}
): AssignmentRecord {
  return {
    armIndex: i % 2,
    ctxKey: null,
    featIdx: [0],
    rewardTotal: 0,
    firstSeen: 1_700_000_000_000 + i,
    alg: "ts",
    armCount: 2,
    dim: 16,
    srcHash,
    ...overrides
  };
}

const TIGHT: CapPolicy = { maxSourceShare: 0.1, minSourceFloor: 5 };

describe("source bucketing", () => {
  it("collapses IPv4 to a /24 and IPv6 to a /48", () => {
    expect(ipPrefix("203.0.113.42")).toBe("203.0.113.0/24");
    expect(ipPrefix("203.0.113.7")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
  });

  it("rejects anything that isn't an address", () => {
    expect(ipPrefix("")).toBeNull();
    expect(ipPrefix("not-an-ip")).toBeNull();
    expect(ipPrefix("999.1.1")).toBeNull();
  });

  it("is per-test and per-day, so it is not an identifier", async () => {
    const day = Date.UTC(2026, 7, 2);
    const nextDay = Date.UTC(2026, 7, 3);
    const a = await sourceHash("a".repeat(64), "203.0.113.42", day);
    const sameTestSameDay = await sourceHash(
      "a".repeat(64),
      "203.0.113.9",
      day
    );
    const otherTest = await sourceHash("b".repeat(64), "203.0.113.42", day);
    const otherDay = await sourceHash("a".repeat(64), "203.0.113.42", nextDay);
    expect(a).toBe(sameTestSameDay); // same /24 collapses
    expect(a).not.toBe(otherTest); // unlinkable across tests
    expect(a).not.toBe(otherDay); // rotates daily
  });

  it("yields no hash without an address", async () => {
    expect(await sourceHash("a".repeat(64), null, Date.now())).toBeNull();
  });

  it("names the day in UTC", () => {
    expect(utcDay(Date.UTC(2026, 7, 2, 23, 59))).toBe("2026-08-02");
  });
});

describe("capContributions", () => {
  it("passes everything through when traffic is diverse", () => {
    const events = Array.from({ length: 30 }, (_, i) => rec(i, `src${i % 10}`));
    const result = capContributions(events, TIGHT);
    expect(result.applied).toHaveLength(30);
    expect(result.excluded.total).toBe(0);
  });

  it("caps a single source that floods a test", () => {
    // 5 genuine sources, plus one source contributing 200 records.
    const genuine = Array.from({ length: 50 }, (_, i) => rec(i, `src${i % 5}`));
    const flood = Array.from({ length: 200 }, (_, i) =>
      rec(100 + i, "attacker")
    );
    const result = capContributions([...genuine, ...flood], TIGHT);
    // cap = max(5, ceil(0.1 * 250)) = 25
    const attackerApplied = result.applied.filter(
      r => r.srcHash === "attacker"
    );
    expect(attackerApplied).toHaveLength(25);
    expect(result.excluded.byCap).toBe(175);
    // Genuine traffic is untouched.
    expect(result.applied.filter(r => r.srcHash !== "attacker")).toHaveLength(
      50
    );
  });

  it("keeps the earliest records of a capped source (deterministic)", () => {
    const events = Array.from({ length: 20 }, (_, i) => rec(i, "one"));
    const a = capContributions(events, TIGHT);
    const b = capContributions([...events].reverse(), TIGHT);
    expect(a.applied.map(r => r.firstSeen)).toEqual(
      b.applied.map(r => r.firstSeen)
    );
    expect(a.applied[0].firstSeen).toBe(events[0].firstSeen);
  });

  it("never caps sourceless records as one bucket", () => {
    // Anonymous traffic and records predating srcHash share "unknown";
    // capping them together would silently drop real history.
    const events = Array.from({ length: 100 }, (_, i) => rec(i, null));
    const result = capContributions(events, TIGHT);
    expect(result.applied).toHaveLength(100);
    expect(result.excluded.total).toBe(0);
  });

  it("honors creator-quarantined sources and windows", () => {
    const events = [
      rec(0, "good"),
      rec(1, "bad"),
      rec(2, "good", { firstSeen: 5_000 }),
      rec(3, "good", { firstSeen: 6_000 })
    ];
    const result = capContributions(events, {
      ...TIGHT,
      excludedSources: ["bad"],
      excludedWindows: [{ since: 4_500, until: 5_500 }]
    });
    expect(result.excluded.bySource).toBe(1);
    expect(result.excluded.byWindow).toBe(1);
    expect(result.applied).toHaveLength(2);
  });

  it("reports the per-source breakdown the creator sees", () => {
    const result = capContributions(
      [rec(0, "a"), rec(1, "a"), rec(2, "b")],
      TIGHT
    );
    expect(result.perSource).toEqual({ a: 2, b: 1 });
  });

  it("uses the floor so small tests are never capped", () => {
    const events = Array.from({ length: 40 }, (_, i) => rec(i, "one"));
    // Default floor is 50, so 40 records from one source still count.
    const result = capContributions(events, DEFAULT_CAP_POLICY);
    expect(result.applied).toHaveLength(40);
  });
});

describe("sourceWithinCap (live path)", () => {
  it("agrees with the batch cap at the boundary", () => {
    expect(sourceWithinCap(25, 250, TIGHT)).toBe(true);
    expect(sourceWithinCap(26, 250, TIGHT)).toBe(false);
  });

  it("respects the floor for small tests", () => {
    expect(sourceWithinCap(5, 10, TIGHT)).toBe(true);
    expect(sourceWithinCap(6, 10, TIGHT)).toBe(false);
  });
});
