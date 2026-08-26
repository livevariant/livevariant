import {
  parseHandoff,
  stripHandoffParams,
  type Handoff
} from "@livevariant/core";

/**
 * Client half of the redirect identity handoff. On page load the SDK
 * captures _lvt/_lvid/_lvvar from the URL, stores them, and cleans the
 * address bar the way gclid handlers do. Stored handoffs are what lets
 * a GTM-deployed SDK attribute conversions for tests the page itself
 * never rendered. How long they live is the storage's business: the
 * default sessionStorage holds them for the tab's lifetime (a
 * pages-later conversion in the same tab attributes), "none" mode keeps
 * them only until navigation, and the "local-storage" opt-in keeps them
 * across visits up to the TTL below.
 */

const STORAGE_PREFIX = "lv:h:";
/** Handoffs older than this no longer accept conversions client-side. */
const HANDOFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredHandoff extends Handoff {
  capturedAt: number;
}

/** Reads the handoff from the current URL, stores it, and cleans the URL. */
export function captureHandoff(
  win: Window,
  storage: Storage | null
): StoredHandoff | null {
  const handoff = parseHandoff(win.location.search);
  if (!handoff) {
    return null;
  }
  const stored: StoredHandoff = { ...handoff, capturedAt: Date.now() };
  storage?.setItem(STORAGE_PREFIX + handoff.testId, JSON.stringify(stored));
  const cleaned =
    win.location.pathname +
    stripHandoffParams(win.location.search) +
    win.location.hash;
  win.history.replaceState(win.history.state, "", cleaned);
  return stored;
}

export function getHandoff(
  storage: Storage | null,
  testId: string
): StoredHandoff | null {
  const raw = storage?.getItem(STORAGE_PREFIX + testId);
  if (!raw) {
    return null;
  }
  try {
    const stored = JSON.parse(raw) as StoredHandoff;
    if (Date.now() - stored.capturedAt > HANDOFF_TTL_MS) {
      storage?.removeItem(STORAGE_PREFIX + testId);
      return null;
    }
    return stored;
  } catch {
    storage?.removeItem(STORAGE_PREFIX + testId);
    return null;
  }
}

/** Every live handoff in storage (the GTM auto-track reward targets). */
export function listHandoffs(storage: Storage | null): StoredHandoff[] {
  if (!storage) {
    return [];
  }
  // Collect keys BEFORE reading: getHandoff removes expired entries, and
  // removal during an index loop re-compacts the key list and skips the
  // entry that slides into the freed slot.
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) {
      keys.push(key);
    }
  }
  const handoffs: StoredHandoff[] = [];
  for (const key of keys) {
    const stored = getHandoff(storage, key.slice(STORAGE_PREFIX.length));
    if (stored) {
      handoffs.push(stored);
    }
  }
  return handoffs;
}
