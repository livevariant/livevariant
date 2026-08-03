import type { CellCounts, DerivedState, JointModel } from "@livevariant/core";
import { counterKey, GLOBAL_SCOPE } from "./types.js";

/**
 * Mapping between core's DerivedState and the store's physical artifacts:
 * the per-cell counter array is [pulls0, successes0, pulls1, ...] so a
 * pull or success is a single atomic increment, and the joint model is
 * one versioned JSON blob (stamped with the shape it was built for, so a
 * blob from a different shape is detectably stale rather than silently
 * mis-indexed).
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

export function modelToBlob(blob: ModelBlob): string {
  return JSON.stringify(blob);
}

export function blobToModel(data: string): ModelBlob {
  return JSON.parse(data) as ModelBlob;
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
