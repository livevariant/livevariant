/**
 * The default client-side store: Storage-shaped, held on the window so
 * every LiveVariant bundle on the page shares one, and gone with the
 * page. Being the DEFAULT is the point: sticky assignments, handoff
 * capture and cross-bundle reward coordination all work for the life of
 * the page while the SDK writes nothing a consent banner would have to
 * ask about. Deployments that want identity and conversions to survive
 * navigation opt INTO localStorage (`storage: window.localStorage` in
 * code, `data-storage="local"` on the tag) and own that consent story.
 *
 * On the window rather than module state because bundles don't share
 * modules: the tag and an npm SDK coordinate rewards through the lv:a:*
 * keys, so they must see one store (the same reason the auto-track
 * watcher claim lives on the window).
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
export type StorageMode = "page" | "local" | "none";

/**
 * Maps a declared mode to a store: "local" is the persistence opt-in,
 * "none" disables caching entirely, anything else (including absence
 * and unknown future values) is the page store.
 */
export function resolveStorage(win: Window, mode?: string): Storage | null {
  if (mode === "local") {
    return win.localStorage;
  }
  if (mode === "none") {
    return null;
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
