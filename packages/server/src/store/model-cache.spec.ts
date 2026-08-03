import { describe, expect, it } from "vitest";
import { newDerivedState } from "@livevariant/core";
import { ModelCache } from "./model-cache.js";

function blob(marker = 0) {
  const state = newDerivedState({ slotSizes: [2], dim: 16 });
  state.model.b[1] = marker;
  return { slotSizes: [2], dim: 16, model: state.model };
}

const T1 = "a".repeat(64);

describe("ModelCache", () => {
  it("hits only on the exact version", () => {
    const cache = new ModelCache();
    cache.set(T1, 3, blob(7));
    expect(cache.get(T1, 3)?.model.b[1]).toBe(7);
    expect(cache.get(T1, 2)).toBeNull();
    expect(cache.get(T1, 4)).toBeNull();
    expect(cache.get("b".repeat(64), 3)).toBeNull();
  });

  it("isolates callers from each other and from the cache", () => {
    // Callers mutate the model before a CAS write; a failed CAS must not
    // leave the cache dirty, and one caller's mutation must not leak
    // into another's read. Copies on both ends.
    const cache = new ModelCache();
    const original = blob(1);
    cache.set(T1, 1, original);
    original.model.b[1] = 999; // caller keeps mutating after set
    const first = cache.get(T1, 1)!;
    expect(first.model.b[1]).toBe(1);
    first.model.b[1] = 555; // reader mutates what it got
    expect(cache.get(T1, 1)!.model.b[1]).toBe(1);
  });

  it("evicts the least recently used test past its cap", () => {
    const cache = new ModelCache(2);
    cache.set("t1", 1, blob());
    cache.set("t2", 1, blob());
    expect(cache.get("t1", 1)).not.toBeNull(); // refresh t1
    cache.set("t3", 1, blob()); // evicts t2, the stalest
    expect(cache.get("t1", 1)).not.toBeNull();
    expect(cache.get("t2", 1)).toBeNull();
    expect(cache.get("t3", 1)).not.toBeNull();
  });
});
