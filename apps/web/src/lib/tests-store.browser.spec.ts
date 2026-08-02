import { beforeEach, describe, expect, it } from "vitest";
import { loadTests, removeTest, saveTest, type SavedTest } from "./tests-store";

/**
 * This module holds the user's only copy of every stats secret: a
 * regression here silently loses access to running tests, so the
 * persistence rules are pinned.
 */

function test(overrides: Partial<SavedTest> = {}): SavedTest {
  return {
    name: "hero test",
    encoded: "eyJ2IjoxfQ",
    testId: "a".repeat(64),
    statsSecret: "s3cret",
    serverUrl: "https://livevariant.link",
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("tests-store", () => {
  it("round-trips a saved test", () => {
    saveTest(test());
    const [saved] = loadTests();
    expect(saved.statsSecret).toBe("s3cret");
    expect(saved.testId).toBe("a".repeat(64));
  });

  it("recovers from corrupt storage instead of throwing", () => {
    localStorage.setItem("lv:tests", "{not json");
    expect(loadTests()).toEqual([]);
  });

  it("replaces by testId rather than duplicating", () => {
    saveTest(test());
    saveTest(test({ name: "renamed" }));
    const all = loadTests();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("renamed");
  });

  it("puts the newest test first", () => {
    saveTest(test({ testId: "b".repeat(64), name: "older" }));
    saveTest(test({ testId: "c".repeat(64), name: "newer" }));
    expect(loadTests().map(t => t.name)).toEqual(["newer", "older"]);
  });

  it("removes only the named test", () => {
    saveTest(test({ testId: "b".repeat(64) }));
    saveTest(test({ testId: "c".repeat(64) }));
    removeTest("b".repeat(64));
    expect(loadTests().map(t => t.testId)).toEqual(["c".repeat(64)]);
  });

  it("ignores removal of an unknown test", () => {
    saveTest(test());
    removeTest("f".repeat(64));
    expect(loadTests()).toHaveLength(1);
  });
});
