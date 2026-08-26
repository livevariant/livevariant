import { describe, expect, it } from "vitest";
import {
  pageStorage,
  registeredStores,
  registerStore,
  resetStoreRegistry,
  resolveStorage
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
    expect(resolveStorage(window)).toBe(window.sessionStorage);
    expect(resolveStorage(window, "session-storage")).toBe(
      window.sessionStorage
    );
    expect(resolveStorage(window, "local-storage")).toBe(window.localStorage);
    // "none" means no web storage, not no SDK: the window store keeps
    // tests sticky and rewardable for the page's lifetime.
    expect(resolveStorage(window, "none")).toBe(pageStorage(window));
    // Forward-compatible: a mode this version does not know degrades to
    // the window store, never to a persistence surprise.
    expect(resolveStorage(window, "future-mode")).toBe(pageStorage(window));
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
