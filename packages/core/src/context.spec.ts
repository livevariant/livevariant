import { describe, expect, it } from "vitest";
import {
  bucketKey,
  composeBucketKey,
  deriveAutoCtx,
  deriveResolvedCtx,
  enumerateBucketLabels,
  featureIndices,
  mergeFeatureIndices,
  normalizeCtx,
  splitAutoDims
} from "./context.js";
import { testConfigSchema } from "./schema.js";

function configWithDims(dims: unknown[]) {
  return testConfigSchema.parse({
    variants: ["A", "B"],
    ctx: { dims },
    statsKeyHash: "0".repeat(64)
  });
}

describe("normalizeCtx", () => {
  it("keeps declared keys and drops everything else", () => {
    const config = configWithDims([{ key: "persona" }, { key: "country" }]);
    expect(normalizeCtx(config, { persona: "power", spam: "x" })).toEqual({
      persona: "power"
    });
  });

  it("treats a declared value list as an allowlist", () => {
    // Without this a crafted ?c_country= mints an unbounded number of
    // bucket counters on a test nobody can moderate.
    const config = configWithDims([{ key: "country", values: ["nl", "de"] }]);
    expect(normalizeCtx(config, { country: "de" })).toEqual({ country: "de" });
    expect(normalizeCtx(config, { country: "zz" })).toBeNull();
  });

  it("caps free-form values so one visitor cannot mint a giant key", () => {
    const config = configWithDims([{ key: "persona" }]);
    expect(normalizeCtx(config, { persona: "x".repeat(65) })).toBeNull();
    expect(normalizeCtx(config, { persona: "x".repeat(64) })).not.toBeNull();
  });
});

describe("deriveAutoCtx", () => {
  const config = configWithDims([
    { key: "country", from: "country" },
    { key: "device", from: "device" },
    { key: "persona" }
  ]);
  const signals = { country: "nl", device: "mobile", city: "amsterdam" };

  it("fills only the dimensions that asked for a signal", () => {
    // `persona` has no `from`, and `city` is not wired to any dimension.
    expect(deriveAutoCtx(config.ctx?.dims, signals, null)).toEqual({
      country: "nl",
      device: "mobile"
    });
  });

  it("lets the caller's own value win", () => {
    // The integrator knows their users better than an IP database does,
    // but the value still comes back here rather than staying in the
    // caller's context: see splitAutoDims.
    expect(deriveAutoCtx(config.ctx?.dims, signals, { country: "de" })).toEqual(
      {
        country: "de",
        device: "mobile"
      }
    );
  });

  it("still honours a declared allowlist", () => {
    const limited = configWithDims([
      { key: "country", from: "country", values: ["de", "fr"] }
    ]);
    expect(deriveAutoCtx(limited.ctx?.dims, signals, null)).toEqual({});
  });

  it("derives nothing when the request yielded no signals", () => {
    expect(deriveAutoCtx(config.ctx?.dims, {}, null)).toEqual({});
  });
});

describe("composeBucketKey", () => {
  const testId = "a".repeat(64);

  it("leaves the caller's key untouched when nothing was derived", async () => {
    // Back-compat: a test with no auto dimensions must keep the exact
    // bucket keys it has been accumulating history under.
    const callerKey = await bucketKey(testId, { persona: "power" });
    expect(await composeBucketKey(testId, callerKey, {})).toBe(callerKey);
    expect(await composeBucketKey(testId, null, {})).toBeNull();
  });

  it("puts a supplied and a derived value in the same bucket", async () => {
    // The bug this pins: one visitor's country arrives as ?c_country=nl,
    // another's is derived from their IP. If the supplied one stayed in
    // the caller's key while the derived one was composed on top, one
    // effective context would learn in two disjoint halves.
    const config = configWithDims([
      { key: "country", from: "country" },
      { key: "persona" }
    ]);
    const raw = { persona: "power" };
    const supplied = { ...raw, country: "nl" };

    const suppliedKey = await composeBucketKey(
      testId,
      await bucketKey(testId, splitAutoDims(config.ctx?.dims, supplied)!),
      deriveAutoCtx(config.ctx?.dims, { country: "de" }, supplied)
    );
    const derivedKey = await composeBucketKey(
      testId,
      await bucketKey(testId, splitAutoDims(config.ctx?.dims, raw)!),
      deriveAutoCtx(config.ctx?.dims, { country: "nl" }, raw)
    );
    expect(suppliedKey).toBe(derivedKey);
  });

  it("separates derived values and stays inside the test", async () => {
    const callerKey = await bucketKey(testId, { persona: "power" });
    const nl = await composeBucketKey(testId, callerKey, { country: "nl" });
    const de = await composeBucketKey(testId, callerKey, { country: "de" });
    expect(nl).not.toBe(de);
    const otherTest = await composeBucketKey("b".repeat(64), callerKey, {
      country: "nl"
    });
    expect(otherTest).not.toBe(nl);
  });
});

describe("enumerateBucketLabels", () => {
  const testId = "a".repeat(64);

  it("recovers the label for a caller-hashed bucket", async () => {
    const config = configWithDims([{ key: "plan", values: ["free", "pro"] }]);
    const labels = await enumerateBucketLabels(testId, config.ctx?.dims);
    expect(labels.get(await bucketKey(testId, { plan: "pro" }))).toBe(
      "plan=pro"
    );
    expect(labels.size).toBe(2);
  });

  it("labels composed auto-dimension buckets the way serving keys them", async () => {
    const config = configWithDims([
      { key: "plan", values: ["free", "pro"] },
      { key: "country", from: "country", values: ["nl", "de"] }
    ]);
    const labels = await enumerateBucketLabels(testId, config.ctx?.dims);
    // A visitor with both dimensions: caller part hashed, auto part
    // composed on top, exactly as resolveIdentity does it.
    const key = await composeBucketKey(
      testId,
      await bucketKey(testId, { plan: "pro" }),
      { country: "nl" }
    );
    expect(labels.get(key!)).toBe("plan=pro, country=nl");
    // A visitor with only the derived dimension.
    const autoOnly = await composeBucketKey(testId, null, { country: "de" });
    expect(labels.get(autoOnly!)).toBe("country=de");
    // (2 plans + absent) x (2 countries + absent), minus the empty one.
    expect(labels.size).toBe(8);
  });

  it("leaves free-form dimensions unlabeled without giving up on the rest", async () => {
    const config = configWithDims([
      { key: "persona" },
      { key: "plan", values: ["free", "pro"] }
    ]);
    const labels = await enumerateBucketLabels(testId, config.ctx?.dims);
    expect(labels.get(await bucketKey(testId, { plan: "free" }))).toBe(
      "plan=free"
    );
    // A bucket that includes the free-form dimension cannot be matched.
    expect(
      labels.get(await bucketKey(testId, { persona: "power", plan: "free" }))
    ).toBeUndefined();
  });

  it("refuses spaces too large to sweep completely", async () => {
    const config = configWithDims([
      { key: "city", values: Array.from({ length: 40 }, (_, i) => `c${i}`) },
      { key: "tz", values: Array.from({ length: 40 }, (_, i) => `t${i}`) }
    ]);
    // 41 x 41 > 1024: labeling half the buckets would read as meaning.
    expect((await enumerateBucketLabels(testId, config.ctx?.dims)).size).toBe(
      0
    );
    expect((await enumerateBucketLabels(testId, undefined)).size).toBe(0);
  });
});

describe("mergeFeatureIndices", () => {
  it("matches hashing the merged context directly", () => {
    // Each key=value pair hashes to its own slot, so a set union of the
    // two halves is the same vector the linear model would have seen if
    // the caller had sent the whole context itself.
    const caller = featureIndices({ persona: "power" }, 16);
    expect(mergeFeatureIndices(caller, { country: "nl" }, 16)).toEqual(
      featureIndices({ persona: "power", country: "nl" }, 16)
    );
  });

  it("keeps the bias slot when there is nothing to merge", () => {
    expect(mergeFeatureIndices(null, {}, 16)).toEqual([0]);
    expect(mergeFeatureIndices(featureIndices(null, 16), {}, 16)).toEqual([0]);
  });
});

describe("splitAutoDims", () => {
  it("moves auto dimensions out of the caller's key", () => {
    const config = configWithDims([
      { key: "country", from: "country" },
      { key: "persona" }
    ]);
    expect(
      splitAutoDims(config.ctx?.dims, { country: "nl", persona: "power" })
    ).toEqual({
      persona: "power"
    });
    expect(splitAutoDims(config.ctx?.dims, { country: "nl" })).toBeNull();
  });

  it("leaves a config without auto dimensions exactly as it was", () => {
    // Back-compat: these tests keep the bucket keys they already have
    // history under.
    const config = configWithDims([{ key: "persona" }]);
    const ctx = { persona: "power" };
    expect(splitAutoDims(config.ctx?.dims, ctx)).toBe(ctx);
    expect(splitAutoDims(config.ctx?.dims, null)).toBeNull();
  });
});

describe("deriveResolvedCtx", () => {
  const dims = [
    { key: "segment", values: ["north", "south"], resolve: "area-lookup" },
    { key: "persona" }
  ];

  it("takes the resolver's answer for its own dimension only", () => {
    const config = configWithDims(dims);
    expect(
      deriveResolvedCtx(
        config.ctx?.dims,
        { segment: "north", persona: "ignored" },
        null
      )
    ).toEqual({ segment: "north" });
  });

  it("lets a caller-supplied value win", () => {
    const config = configWithDims(dims);
    expect(
      deriveResolvedCtx(
        config.ctx?.dims,
        { segment: "north" },
        {
          segment: "south"
        }
      )
    ).toEqual({ segment: "south" });
  });

  it("enforces the declared allowlist against the resolver too", () => {
    // A resolver is not more trusted than a query parameter: without this
    // a buggy lookup fragments a test into unbounded buckets.
    const config = configWithDims(dims);
    expect(
      deriveResolvedCtx(config.ctx?.dims, { segment: "elsewhere" }, null)
    ).toEqual({});
    expect(deriveResolvedCtx(config.ctx?.dims, {}, null)).toEqual({});
  });

  it("buckets a resolved dimension the same way a derived one buckets", async () => {
    // Composition has to be identical or the same effective context
    // splits in two, and stats labels stop matching real buckets.
    const config = configWithDims(dims);
    const resolved = deriveResolvedCtx(
      config.ctx?.dims,
      { segment: "north" },
      null
    );
    const key = await composeBucketKey("t", null, resolved);
    const labels = await enumerateBucketLabels("t", config.ctx?.dims);
    expect(labels.get(key!)).toBe("segment=north");
  });
});

describe("a dimension is filled one way or the other", () => {
  it("refuses both a signal and a resolver", () => {
    expect(() =>
      configWithDims([{ key: "x", from: "country", resolve: "lookup" }])
    ).toThrow();
  });
});
