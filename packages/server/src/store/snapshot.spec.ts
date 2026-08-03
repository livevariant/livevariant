import { describe, expect, it } from "vitest";
import {
  dimForShape,
  newDerivedState,
  observe,
  reward
} from "@livevariant/core";
import { blobToModel, modelToBlob } from "./snapshot.js";

describe("model blob codec", () => {
  it("round-trips a trained model exactly", () => {
    // Float64 bytes in, Float64 bytes out: the round trip must be exact,
    // not approximately equal, or incremental state and its own
    // serialization would drift apart.
    const slotSizes = [2, 3];
    const dim = dimForShape(slotSizes);
    const state = newDerivedState({
      slotSizes,
      dim,
      priors: [{ slot: 0, variant: 1, mean: 0.07, strength: 20 }]
    });
    observe(state.model, [0, 3, 5]);
    reward(state.model, [0, 3, 5]);
    observe(state.model, [0, 4]);

    const decoded = blobToModel(
      modelToBlob({ slotSizes, dim, model: state.model })
    );
    expect(decoded.slotSizes).toEqual(slotSizes);
    expect(decoded.dim).toBe(dim);
    expect(decoded.model.aInv).toEqual(state.model.aInv);
    expect(decoded.model.b).toEqual(state.model.b);
  });

  it("keeps the shape readable without decoding the matrix", () => {
    // The conformance suite (and any human at a storage console) can
    // read dim/slotSizes straight off the JSON wrapper.
    const blob = modelToBlob({
      slotSizes: [2],
      dim: 16,
      model: newDerivedState({ slotSizes: [2], dim: 16 }).model
    });
    const wire = JSON.parse(blob) as { dim: number; slotSizes: number[] };
    expect(wire.dim).toBe(16);
    expect(wire.slotSizes).toEqual([2]);
  });

  it("throws on garbage rather than returning a poisoned model", () => {
    expect(() => blobToModel("not json")).toThrow();
    expect(() => blobToModel('{"v":1}')).toThrow();
    expect(() => blobToModel('{"v":2,"dim":16,"slotSizes":[2]}')).toThrow();
    // The matrix must agree with the declared dim: a truncated payload
    // would silently produce a wrong-shaped model.
    const good = modelToBlob({
      slotSizes: [2],
      dim: 16,
      model: newDerivedState({ slotSizes: [2], dim: 16 }).model
    });
    const wire = JSON.parse(good) as Record<string, unknown>;
    expect(() => blobToModel(JSON.stringify({ ...wire, dim: 32 }))).toThrow(
      /disagrees/
    );
  });
});
