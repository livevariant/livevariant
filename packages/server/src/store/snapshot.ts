import type { ArmCounts, DerivedState } from "@livevariant/core";
import { counterKey, GLOBAL_SCOPE } from "./types.js";

/**
 * Mapping between core's DerivedState and the store's physical artifacts:
 * counter arrays are [pulls0, successes0, pulls1, successes1, ...] so a
 * pull or success is a single atomic increment, and linear state is one
 * versioned JSON blob.
 */

export function countsToArray(arms: ArmCounts[]): number[] {
  const flat: number[] = [];
  for (const { pulls, successes } of arms) {
    flat.push(pulls, successes);
  }
  return flat;
}

export function arrayToCounts(flat: number[], armCount: number): ArmCounts[] {
  return Array.from({ length: armCount }, (_, i) => ({
    pulls: flat[2 * i] ?? 0,
    successes: flat[2 * i + 1] ?? 0
  }));
}

/** Delta array for one pull (optionally with its success) of an arm. */
export function pullDelta(
  armCount: number,
  armIndex: number,
  success: boolean
): number[] {
  const deltas = new Array<number>(armCount * 2).fill(0);
  deltas[2 * armIndex] = 1;
  if (success) {
    deltas[2 * armIndex + 1] = 1;
  }
  return deltas;
}

/** Delta array for a success on an already-counted pull. */
export function successDelta(armCount: number, armIndex: number): number[] {
  const deltas = new Array<number>(armCount * 2).fill(0);
  deltas[2 * armIndex + 1] = 1;
  return deltas;
}

export function derivedToArtifacts(
  testId: string,
  state: DerivedState
): { counters: Map<string, number[]>; blob: string | null } {
  const counters = new Map<string, number[]>();
  let blob: string | null = null;
  switch (state.alg) {
    case "ts":
      counters.set(counterKey(testId, GLOBAL_SCOPE), countsToArray(state.arms));
      break;
    case "bucketed":
      counters.set(
        counterKey(testId, GLOBAL_SCOPE),
        countsToArray(state.global)
      );
      for (const [ctxKey, arms] of Object.entries(state.buckets)) {
        counters.set(counterKey(testId, ctxKey), countsToArray(arms));
      }
      break;
    case "linear":
      blob = JSON.stringify({ dim: state.dim, arms: state.arms });
      break;
  }
  return { counters, blob };
}

export function blobToLinearState(
  data: string
): Extract<DerivedState, { alg: "linear" }> {
  const parsed = JSON.parse(data) as {
    dim: number;
    arms: { aInv: number[][]; b: number[] }[];
  };
  return { alg: "linear", dim: parsed.dim, arms: parsed.arms };
}
