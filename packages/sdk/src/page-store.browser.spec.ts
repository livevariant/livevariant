import { describe, expect, it } from "vitest";
import { pageStorage, resolveStorage } from "./page-store.js";

/**
 * The page store is the default home for identity, assignments and
 * handoffs, and its one structural promise is Storage-compatibility on
 * a WINDOW-SHARED instance: the tag and an npm bundle are separate
 * module graphs, so if each got its own store, auto-track could not see
 * createTest's assignments and rewards would silently stop.
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
  it("maps the declared modes and defaults unknowns to the page store", () => {
    expect(resolveStorage(window, "local")).toBe(window.localStorage);
    expect(resolveStorage(window, "none")).toBeNull();
    expect(resolveStorage(window)).toBe(pageStorage(window));
    // Forward-compatible: a mode this version does not know degrades to
    // the page store, never to a persistence surprise.
    expect(resolveStorage(window, "future-mode")).toBe(pageStorage(window));
  });
});
