/**
 * Account-free persistence: tests you create live in YOUR browser
 * (localStorage), including the stats secret. Nothing is registered
 * server-side, which is the whole point; accounts and org claiming come
 * later on the hosted tier.
 */
export interface SavedTest {
  name: string;
  encoded: string;
  testId: string;
  statsSecret: string;
  serverUrl: string;
  createdAt: number;
}

const KEY = "lv:tests";

export function loadTests(): SavedTest[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedTest[];
  } catch {
    return [];
  }
}

export function saveTest(test: SavedTest): void {
  const all = loadTests().filter(t => t.testId !== test.testId);
  all.unshift(test);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function removeTest(testId: string): void {
  localStorage.setItem(
    KEY,
    JSON.stringify(loadTests().filter(t => t.testId !== testId))
  );
}

/** Default serving origin; self-hosters change it in the builder. */
export const DEFAULT_SERVER_URL =
  "https://livevariant.livevariant-workers.workers.dev";
