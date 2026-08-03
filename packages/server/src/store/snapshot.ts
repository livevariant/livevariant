import type { CellCounts, DerivedState, JointModel } from "@livevariant/core";
import { counterKey, GLOBAL_SCOPE } from "./types.js";

/**
 * Mapping between core's DerivedState and the store's physical artifacts:
 * the per-cell counter array is [pulls0, successes0, pulls1, ...] so a
 * pull or success is a single atomic increment, and the joint model is
 * one versioned blob (stamped with the shape it was built for, so a blob
 * from a different shape is detectably stale rather than silently
 * mis-indexed).
 *
 * The blob is JSON, deliberately. A base64-of-Float64 encoding was
 * built and benchmarked (trained model, dim 256): JSON was SMALLER
 * (564KB vs 685KB, shortest-roundtrip floats average ~9 chars while
 * base64 pays its fixed 4/3) and faster in both directions (~1.9ms
 * parse / ~2.1ms stringify vs ~2.5ms / ~12ms), because V8's JSON paths
 * are native while base64 byte-shuffling runs in JS, and the latin1
 * TextDecoder shortcut is unavailable (WHATWG aliases it to
 * windows-1252, whose 0x80-0x9F mappings btoa rejects). The decode cost
 * that remains is paid once per model version anyway: ModelCache keeps
 * decoded models in memory, keyed by blob version.
 */

export function countsToArray(cells: CellCounts[]): number[] {
  const flat: number[] = [];
  for (const { pulls, successes } of cells) {
    flat.push(pulls, successes);
  }
  return flat;
}

export function arrayToCounts(flat: number[], cellCount: number): CellCounts[] {
  return Array.from({ length: cellCount }, (_, i) => ({
    pulls: flat[2 * i] ?? 0,
    successes: flat[2 * i + 1] ?? 0
  }));
}

/** Delta array for one pull of a cell (successes use successDelta). */
export function pullDelta(cellCount: number, cell: number): number[] {
  const deltas = new Array<number>(cellCount * 2).fill(0);
  deltas[2 * cell] = 1;
  return deltas;
}

/** Delta array for a success on an already-counted pull. */
export function successDelta(cellCount: number, cell: number): number[] {
  const deltas = new Array<number>(cellCount * 2).fill(0);
  deltas[2 * cell + 1] = 1;
  return deltas;
}

export interface ModelBlob {
  slotSizes: number[];
  dim: number;
  model: JointModel;
}

interface BlobWire {
  v: 1;
  slotSizes: number[];
  dim: number;
  model: JointModel;
}

export function modelToBlob(blob: ModelBlob): string {
  const wire: BlobWire = {
    v: 1,
    slotSizes: blob.slotSizes,
    dim: blob.dim,
    model: blob.model
  };
  return JSON.stringify(wire);
}

/**
 * Throws on anything malformed; callers treat that as "no usable model"
 * (a recompute rebuilds the real one from the event log).
 */
export function blobToModel(data: string): ModelBlob {
  const wire = JSON.parse(data) as BlobWire;
  const { dim, slotSizes, model } = wire;
  if (
    wire.v !== 1 ||
    !Number.isInteger(dim) ||
    dim < 1 ||
    !Array.isArray(slotSizes) ||
    !Array.isArray(model?.aInv) ||
    !Array.isArray(model?.b) ||
    model.aInv.length !== dim ||
    model.b.length !== dim ||
    model.aInv.some(row => !Array.isArray(row) || row.length !== dim)
  ) {
    throw new Error("model blob shape disagrees with its dim");
  }
  return { slotSizes, dim, model };
}

export function derivedToArtifacts(
  testId: string,
  state: DerivedState
): { counters: Map<string, number[]>; blob: string } {
  const counters = new Map<string, number[]>([
    [counterKey(testId, GLOBAL_SCOPE), countsToArray(state.cells)]
  ]);
  return {
    counters,
    blob: modelToBlob({
      slotSizes: state.slotSizes,
      dim: state.dim,
      model: state.model
    })
  };
}
