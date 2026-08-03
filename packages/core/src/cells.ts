/**
 * A test's action space is the cartesian product of its slots: every
 * combination of one variant per slot is one CELL, identified by a single
 * integer. Records, counters, rewards, quarantine and the decision math
 * all work on cells, which is why a multi-slot test needs no new
 * machinery downstream; the model is the only place that thinks in
 * factored terms.
 *
 * A single-slot test is the degenerate case: cell index = variant index.
 *
 * The cap exists because cells are enumerated: at serving time the
 * chooser scores every cell exactly (no greedy search, no local optima),
 * and stats keep a counter per cell. 512 cells of a few floats is
 * nothing; an unbounded product would be a paging problem and a test no
 * amount of traffic could ever learn.
 */
export const MAX_CELLS = 512;

/** Total number of cells for the given per-slot variant counts. */
export function cellCount(slotSizes: number[]): number {
  return slotSizes.reduce((product, n) => product * n, 1);
}

/**
 * Cell index for one variant choice per slot, row-major over the slot
 * order (slots are canonically ordered by key, see schema.ts).
 */
export function encodeCell(slotSizes: number[], choice: number[]): number {
  let cell = 0;
  for (let i = 0; i < slotSizes.length; i++) {
    cell = cell * slotSizes[i] + choice[i];
  }
  return cell;
}

/** Per-slot variant indices for a cell; inverse of encodeCell. */
export function decodeCell(slotSizes: number[], cell: number): number[] {
  const choice = new Array<number>(slotSizes.length).fill(0);
  let rest = cell;
  for (let i = slotSizes.length - 1; i >= 0; i--) {
    choice[i] = rest % slotSizes[i];
    rest = Math.floor(rest / slotSizes[i]);
  }
  return choice;
}

/** True when a recorded cell fits the shape it claims. */
export function validCell(slotSizes: number[], cell: number): boolean {
  return (
    Number.isInteger(cell) &&
    cell >= 0 &&
    cell < cellCount(slotSizes) &&
    slotSizes.every(n => Number.isInteger(n) && n >= 1)
  );
}
