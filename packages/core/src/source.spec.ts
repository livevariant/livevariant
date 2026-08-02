import { describe, expect, it } from "vitest";
import { ipPrefix, rateLimitBucket, sourceHash, utcDay } from "./source.js";

describe("source bucketing", () => {
  it("collapses IPv4 to a /24 and IPv6 to a /48", () => {
    expect(ipPrefix("203.0.113.42")).toBe("203.0.113.0/24");
    expect(ipPrefix("203.0.113.7")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
  });

  it("expands :: to the right run of zero groups", () => {
    // The bug this pins: a naive split reads 2001::1 as 2001:0:1, so two
    // addresses inside one /48 land in different buckets and a single
    // source gets an unlimited supply of fresh buckets.
    expect(ipPrefix("2001::1")).toBe("2001:0:0::/48");
    expect(ipPrefix("2001::2")).toBe("2001:0:0::/48");
    expect(ipPrefix("::1")).toBe("0:0:0::/48");
    expect(ipPrefix("2001:db8::1")).toBe("2001:db8:0::/48");
    // Compressed and uncompressed forms of one address agree.
    expect(ipPrefix("2001:db8:0:0:0:0:0:99")).toBe(ipPrefix("2001:db8::99"));
    // Leading zeros are canonicalized.
    expect(ipPrefix("2001:0db8:0034::1")).toBe("2001:db8:34::/48");
  });

  it("handles zone ids, brackets, and IPv4-mapped addresses", () => {
    expect(ipPrefix("fe80::1%eth0")).toBe("fe80:0:0::/48");
    expect(ipPrefix("[2001:db8:1::5]")).toBe("2001:db8:1::/48");
    // An IPv4-mapped address buckets as the IPv4 address it carries.
    expect(ipPrefix("::ffff:203.0.113.42")).toBe("203.0.113.0/24");
  });

  it("rejects anything that isn't an address", () => {
    expect(ipPrefix("")).toBeNull();
    expect(ipPrefix("not-an-ip")).toBeNull();
    expect(ipPrefix("999.1.1")).toBeNull();
    expect(ipPrefix("300.1.1.1")).toBeNull();
    expect(ipPrefix("2001:db8:1")).toBeNull(); // too few groups, no ::
    expect(ipPrefix("1::2::3")).toBeNull(); // two :: runs
    expect(ipPrefix("2001:db8:zz::1")).toBeNull();
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

  it("yields no cap bucket without an address", async () => {
    // Capping exempts unidentified traffic: a deployment behind a proxy
    // that sets no address headers would otherwise put ALL its genuine
    // traffic in one bucket and cap itself.
    expect(await sourceHash("a".repeat(64), null, Date.now())).toBeNull();
    expect(await sourceHash("a".repeat(64), "garbage", Date.now())).toBeNull();
  });

  it("always yields a rate-limit bucket, so the limiter can't be skipped", async () => {
    const now = Date.UTC(2026, 7, 2);
    const missing = await rateLimitBucket("a".repeat(64), null, now);
    const garbage = await rateLimitBucket("a".repeat(64), "garbage", now);
    expect(missing).toMatch(/^[0-9a-f]{64}$/);
    // Unidentified callers share one allowance rather than each getting
    // their own.
    expect(garbage).toBe(missing);
    // A real address still gets its own.
    const real = await rateLimitBucket("a".repeat(64), "203.0.113.1", now);
    expect(real).not.toBe(missing);
  });

  it("names the day in UTC", () => {
    expect(utcDay(Date.UTC(2026, 7, 2, 23, 59))).toBe("2026-08-02");
  });
});
