import { TEST_REGIONS, type TestRegion } from "./signals.js";

/**
 * Redirect -> SDK identity handoff. When /s or /c redirects an identified
 * visitor, the destination URL is decorated with these parameters (the
 * gclid playbook), so an SDK on the destination site can adopt the
 * server-side assignment and attribute later conversions to it. Only the
 * idHash ever travels: destination URLs are captured by every analytics
 * tool on the page, so the raw id must never appear here.
 */
export const HANDOFF_PARAMS = {
  testId: "_lvt",
  idHash: "_lvid",
  cell: "_lvvar",
  region: "_lvr"
} as const;

export interface Handoff {
  testId: string;
  idHash: string;
  /** The served combination, encoded (cells.ts). */
  cell: number;
  /**
   * The test's region, carried so config-less reward paths (the GTM
   * one-tag mode) can route to the right home. Only meaningful when the
   * test pinned one; "eu" tests NEED it, because their state lives in a
   * different object than the plain testId would reach.
   */
  region?: TestRegion;
}

/** Appends handoff params to a destination URL, preserving its own query. */
export function decorateUrl(target: string, handoff: Handoff): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return target;
  }
  url.searchParams.set(HANDOFF_PARAMS.testId, handoff.testId);
  url.searchParams.set(HANDOFF_PARAMS.idHash, handoff.idHash);
  url.searchParams.set(HANDOFF_PARAMS.cell, String(handoff.cell));
  if (handoff.region) {
    url.searchParams.set(HANDOFF_PARAMS.region, handoff.region);
  }
  return url.toString();
}

/** Reads a handoff from a query string; null unless all parts are valid. */
export function parseHandoff(search: string): Handoff | null {
  const params = new URLSearchParams(search);
  const testId = params.get(HANDOFF_PARAMS.testId);
  const idHash = params.get(HANDOFF_PARAMS.idHash);
  const cell = Number(params.get(HANDOFF_PARAMS.cell));
  if (
    !testId ||
    !/^[0-9a-f]{64}$/.test(testId) ||
    !idHash ||
    !/^[0-9a-f]{64}$/.test(idHash) ||
    !Number.isInteger(cell) ||
    cell < 0 ||
    // Sanity bound (MAX_CELLS); callers with the config still validate.
    cell >= 512
  ) {
    return null;
  }
  // Unknown region values are dropped, not fatal: the handoff's core
  // fields still attribute correctly on non-jurisdiction tests.
  const region = params.get(HANDOFF_PARAMS.region);
  const validRegion =
    region && (TEST_REGIONS as readonly string[]).includes(region)
      ? (region as TestRegion)
      : undefined;
  return {
    testId,
    idHash,
    cell,
    ...(validRegion ? { region: validRegion } : {})
  };
}

/** The query string with handoff params removed (for history.replaceState). */
export function stripHandoffParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of Object.values(HANDOFF_PARAMS)) {
    params.delete(name);
  }
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
