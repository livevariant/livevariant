/**
 * Shared fixed-window bookkeeping for the rate limiters (the in-memory
 * store and the Durable Object each keep their own map).
 */
/**
 * Bounds a rate-limit map without the cliff a blanket clear() creates:
 * dropping every window at once would hand a fresh allowance to everyone
 * at the exact moment an attacker pushes the map over its limit. Expired
 * windows are dead anyway, so they go first; only if that frees nothing
 * do we evict the oldest live entries.
 */
export function pruneWindows(
  windows: Map<string, { count: number; windowStart: number }>,
  now: number,
  windowMs = 60_000
): void {
  const before = windows.size;
  for (const [key, entry] of windows) {
    if (now - entry.windowStart >= windowMs) {
      windows.delete(key);
    }
  }
  if (windows.size < before) {
    return;
  }
  const oldestFirst = [...windows.entries()].sort(
    (a, b) => a[1].windowStart - b[1].windowStart
  );
  for (const [key] of oldestFirst.slice(0, Math.ceil(oldestFirst.length / 2))) {
    windows.delete(key);
  }
}
