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
  armIndex: "_lvvar"
} as const;

export interface Handoff {
  testId: string;
  idHash: string;
  armIndex: number;
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
  url.searchParams.set(HANDOFF_PARAMS.armIndex, String(handoff.armIndex));
  return url.toString();
}

/** Reads a handoff from a query string; null unless all parts are valid. */
export function parseHandoff(search: string): Handoff | null {
  const params = new URLSearchParams(search);
  const testId = params.get(HANDOFF_PARAMS.testId);
  const idHash = params.get(HANDOFF_PARAMS.idHash);
  const armIndex = Number(params.get(HANDOFF_PARAMS.armIndex));
  if (
    !testId ||
    !/^[0-9a-f]{64}$/.test(testId) ||
    !idHash ||
    !/^[0-9a-f]{64}$/.test(idHash) ||
    !Number.isInteger(armIndex) ||
    armIndex < 0 ||
    // Sanity bound; callers with the config must still check armCount.
    armIndex >= 100
  ) {
    return null;
  }
  return { testId, idHash, armIndex };
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
