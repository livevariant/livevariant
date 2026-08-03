import { describe, expect, it } from "vitest";
import { cellCount, decodeCell, encodeCell, validCell } from "./cells.js";

describe("cells", () => {
  it("round-trips every cell of a mixed shape", () => {
    const sizes = [2, 3, 4];
    expect(cellCount(sizes)).toBe(24);
    for (let cell = 0; cell < 24; cell++) {
      const choice = decodeCell(sizes, cell);
      expect(encodeCell(sizes, choice)).toBe(cell);
      choice.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(sizes[i]);
      });
    }
  });

  it("degenerates to the variant index for a single slot", () => {
    // The property that keeps every downstream mechanism unchanged for
    // ordinary A/B tests.
    expect(encodeCell([5], [3])).toBe(3);
    expect(decodeCell([5], 3)).toEqual([3]);
  });

  it("rejects cells outside the shape", () => {
    expect(validCell([2, 2], 3)).toBe(true);
    expect(validCell([2, 2], 4)).toBe(false);
    expect(validCell([2, 2], -1)).toBe(false);
    expect(validCell([2, 2], 1.5)).toBe(false);
  });
});
