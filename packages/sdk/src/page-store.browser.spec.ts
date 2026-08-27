import { describe, expect, it } from "vitest";
import {
  localStore,
  pageStorage,
  registeredStores,
  registerStore,
  resetStoreRegistry,
  resetWebStores,
  resolveStorage,
  sessionStore
} from "./page-store.js";

/**
 * The window store backs "none" mode and every fallback, and its one
 * structural promise is Storage-compatibility on a WINDOW-SHARED
 * instance: the tag and an npm bundle are separate module graphs, so if
 * each got its own store, auto-track could not see createTest's
 * assignments and rewards would silently stop.
 */
describe("pageStorage", () => {
  it("returns one store per window, shared across callers", () => {
    const a = pageStorage(window);
    const b = pageStorage(window);
    expect(b).toBe(a);
    a.setItem("lv:x", "1");
    expect(b.getItem("lv:x")).toBe("1");
    a.clear();
  });

  it("behaves like Storage for the key/length scan auto-track does", () => {
    const store = pageStorage(window);
    store.clear();
    store.setItem("lv:a:one", "1");
    store.setItem("lv:h:two", "2");
    store.setItem("other", "3");
    expect(store.length).toBe(3);
    const keys = [store.key(0), store.key(1), store.key(2)];
    expect(keys).toEqual(["lv:a:one", "lv:h:two", "other"]);
    expect(store.key(3)).toBeNull();
    store.removeItem("lv:h:two");
    expect(store.length).toBe(2);
    expect(store.getItem("lv:h:two")).toBeNull();
    store.clear();
    expect(store.length).toBe(0);
  });

  it("never touches localStorage", () => {
    const store = pageStorage(window);
    store.setItem("lv:probe", "x");
    expect(localStorage.getItem("lv:probe")).toBeNull();
    store.removeItem("lv:probe");
  });
});

describe("resolveStorage", () => {
  it("maps the declared modes; the default is sessionStorage", () => {
    // The resolved stores are stable wrappers (one identity per window,
    // so the registry and the watcher dedupe by object), writing through
    // to the real web storage.
    const session = resolveStorage(window)!;
    expect(resolveStorage(window, "session-storage")).toBe(session);
    expect(session).toBe(sessionStore(window));
    session.setItem("lv:mode-probe", "s");
    expect(window.sessionStorage.getItem("lv:mode-probe")).toBe("s");
    expect(window.localStorage.getItem("lv:mode-probe")).toBeNull();
    session.removeItem("lv:mode-probe");

    const local = resolveStorage(window, "local-storage")!;
    expect(local).toBe(localStore(window));
    local.setItem("lv:mode-probe", "l");
    expect(window.localStorage.getItem("lv:mode-probe")).toBe("l");
    expect(window.sessionStorage.getItem("lv:mode-probe")).toBeNull();
    local.removeItem("lv:mode-probe");

    // "none" means no web storage, not no SDK: the window store keeps
    // tests sticky and rewardable for the page's lifetime.
    expect(resolveStorage(window, "none")).toBe(pageStorage(window));
    // Forward-compatible: a mode this version does not know degrades to
    // the window store, never to a persistence surprise.
    expect(resolveStorage(window, "future-mode")).toBe(pageStorage(window));
  });

  it("latches to the window store when a web storage throws mid-use", () => {
    resetWebStores(window);
    pageStorage(window).clear();
    const originalSetItem = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = function () {
        throw new Error("quota");
      };
      const store = sessionStore(window);
      // The throwing write is retried against the window store: no
      // exception reaches the caller, and the value is readable back.
      store.setItem("lv:latch-probe", "x");
      expect(store.getItem("lv:latch-probe")).toBe("x");
      expect(pageStorage(window).getItem("lv:latch-probe")).toBe("x");
    } finally {
      Storage.prototype.setItem = originalSetItem;
      resetWebStores(window);
      pageStorage(window).clear();
      window.sessionStorage.removeItem("lv:latch-probe");
    }
  });
});

describe("registerStore", () => {
  it("keeps one entry per store and ignores null", () => {
    resetStoreRegistry(window);
    const store = pageStorage(window);
    registerStore(window, store);
    registerStore(window, store);
    registerStore(window, null);
    registerStore(window, localStorage);
    expect(registeredStores(window)).toEqual([store, localStorage]);
    resetStoreRegistry(window);
    expect(registeredStores(window)).toEqual([]);
  });
});
