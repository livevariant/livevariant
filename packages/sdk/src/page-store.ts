/**
 * Client-side storage comes in three declared modes, and the DEFAULT is
 * sessionStorage: per-tab, expiring with the session, holding nothing
 * but functional A/B state (which variant this visitor got, which
 * participations a conversion should reward). That is the classic
 * functional-storage posture: sticky assignments and in-tab pages-later
 * conversions work out of the box, with no cross-visit identifier and
 * nothing that outlives the tab. "local-storage" upgrades persistence
 * to cross-visit localStorage and is the deployment's own consent
 * story. "none" means NO web storage at all: the SDK then runs on the
 * window store below, so tests stay sticky and rewardable for the life
 * of the page while nothing is written anywhere a consent rule could
 * reach.
 *
 * The window store lives on the window rather than module state because
 * bundles don't share modules: the tag and an npm SDK coordinate
 * rewards through the lv:a:* keys, so they must see one store (the
 * same reason the auto-track watcher claim lives on the window). It is
 * also the fallback whenever a chosen web storage cannot be touched
 * (privacy modes throw on access), so storage trouble degrades to a
 * working page-lifetime install, never to a broken one.
 */

const PAGE_STORE_KEY = "__lvPageStore";

type PageStoreHolder = Window & { [PAGE_STORE_KEY]?: Storage };

/** The page-lifetime store for this window, created on first use. */
export function pageStorage(win: Window): Storage {
  const holder = win as PageStoreHolder;
  const existing = holder[PAGE_STORE_KEY];
  if (existing) {
    return existing;
  }
  const data = new Map<string, string>();
  const store = {
    get length(): number {
      return data.size;
    },
    key(index: number): string | null {
      return [...data.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      data.set(key, String(value));
    },
    removeItem(key: string): void {
      data.delete(key);
    },
    clear(): void {
      data.clear();
    }
  } as Storage;
  holder[PAGE_STORE_KEY] = store;
  return store;
}

/** The plain-data storage choice a page config or tag attribute can carry. */
export type StorageMode = "session-storage" | "local-storage" | "none";

/** A web storage whose ACCESS can throw (privacy modes); null on trouble. */
function guarded(read: () => Storage): Storage | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

/**
 * Maps a declared mode to a store. Absent means the default,
 * "session-storage". "local-storage" is the cross-visit persistence
 * opt-in. "none" is the window store: no web storage touched, the SDK
 * still fully works for the page's lifetime. An unknown future mode
 * degrades to the window store too, never to surprise persistence, and
 * a web storage that throws on access falls back the same way.
 */
export function resolveStorage(win: Window, mode?: string): Storage | null {
  if (mode === undefined || mode === "session-storage") {
    return guarded(() => win.sessionStorage) ?? pageStorage(win);
  }
  if (mode === "local-storage") {
    return guarded(() => win.localStorage) ?? pageStorage(win);
  }
  return pageStorage(win);
}

const STORE_REGISTRY_KEY = "__lvStoreRegistry";

type RegistryHolder = Window & { [STORE_REGISTRY_KEY]?: Storage[] };

/**
 * Every Storage a LiveVariant surface on this page caches into. The
 * page-wide reward watcher scans all of them, so WHERE a bundle keeps
 * its cache never decides WHETHER its conversions count: the store is a
 * caller's choice (the page store, localStorage, a consent-gated
 * wrapper), and the one watcher, whoever claimed it and with whatever
 * store, must see every cached participation. On the window for the
 * same reason as the page store itself: bundles do not share modules.
 */
export function registerStore(win: Window, store: Storage | null): void {
  if (!store) {
    return;
  }
  const holder = win as RegistryHolder;
  const registry = (holder[STORE_REGISTRY_KEY] ??= []);
  if (!registry.includes(store)) {
    registry.push(store);
  }
}

export function registeredStores(win: Window): readonly Storage[] {
  return (win as RegistryHolder)[STORE_REGISTRY_KEY] ?? [];
}

/** Test hook: forgets the registered stores of a window. */
export function resetStoreRegistry(win: Window): void {
  delete (win as RegistryHolder)[STORE_REGISTRY_KEY];
}
