import { describe, expect, it } from "vitest";
import type { AssignmentRecord } from "@livevariant/core";
import { TestStorage, type StorageLike } from "./test-storage.js";

/**
 * TestStorage is the logic that runs inside the Durable Object; here it
 * runs against a Map-backed mock of the DO storage API. Concurrency is
 * not tested because the DO's single-threaded execution IS the
 * concurrency model.
 */

function mockStorage(): StorageLike {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      return map.delete(key);
    },
    async deleteMany(keys) {
      let deleted = 0;
      for (const key of keys) {
        if (map.delete(key)) {
          deleted++;
        }
      }
      return deleted;
    },
    async list<T>({
      prefix,
      startAfter,
      limit
    }: {
      prefix: string;
      startAfter?: string;
      limit?: number;
    }) {
      const keys = [...map.keys()]
        .filter(k => k.startsWith(prefix))
        .sort()
        .filter(k => (startAfter === undefined ? true : k > startAfter))
        .slice(0, limit ?? Infinity);
      return new Map(keys.map(k => [k, map.get(k) as T]));
    }
  };
}

function rec(armIndex: number): AssignmentRecord {
  return {
    armIndex,
    ctxKey: null,
    featIdx: [0],
    rewardTotal: 0,
    firstSeen: Date.now(),
    alg: "ts",
    armCount: 3,
    dim: 16
  };
}

describe("TestStorage", () => {
  it("keeps the first assignment", async () => {
    const ts = new TestStorage(mockStorage());
    expect((await ts.putAssignmentIfAbsent("id1", rec(0))).created).toBe(true);
    const second = await ts.putAssignmentIfAbsent("id1", rec(1));
    expect(second.created).toBe(false);
    expect(second.rec.armIndex).toBe(0);
  });

  it("accumulates rewards with a single first flag", async () => {
    const ts = new TestStorage(mockStorage());
    expect(await ts.addReward("ghost", 1)).toBeNull();
    await ts.putAssignmentIfAbsent("id1", rec(0));
    expect((await ts.addReward("id1", 1))?.first).toBe(true);
    const second = await ts.addReward("id1", 2);
    expect(second?.first).toBe(false);
    expect(second?.rec.rewardTotal).toBe(3);
  });

  it("pages through assignments", async () => {
    const ts = new TestStorage(mockStorage());
    for (let i = 0; i < 12; i++) {
      await ts.putAssignmentIfAbsent(
        `id${String(i).padStart(2, "0")}`,
        rec(i % 2)
      );
    }
    const collected: AssignmentRecord[] = [];
    let startAfter: string | null = null;
    do {
      const page = await ts.listAssignments(startAfter, 5);
      collected.push(...page.records);
      startAfter = page.nextStartAfter;
    } while (startAfter !== null);
    expect(collected).toHaveLength(12);
  });

  it("handles counters and blob versioning", async () => {
    const ts = new TestStorage(mockStorage());
    await ts.incrCounters("global", [1, 0, 0, 1]);
    await ts.incrCounters("global", [1, 1, 0, 0]);
    expect(await ts.getCounters("global", 4)).toEqual([2, 1, 0, 1]);

    expect(await ts.getBlob()).toBeNull();
    expect(await ts.putBlob("v1", 0)).toBe(true);
    expect(await ts.putBlob("stale", 0)).toBe(false);
    expect((await ts.getBlob())?.version).toBe(1);
  });

  it("pins a policy the creator can extend", async () => {
    const ts = new TestStorage(mockStorage());
    expect(await ts.getPolicy()).toEqual({});
    const merged = await ts.updatePolicy({ excludedSources: ["bad"] });
    expect(merged.excludedSources).toEqual(["bad"]);
    expect((await ts.getPolicy()).excludedSources).toEqual(["bad"]);
  });

  it("replaces derived state and wipes stale scopes", async () => {
    const ts = new TestStorage(mockStorage());
    await ts.incrCounters("stale", [9, 9]);
    await ts.putBlob("old", 0);
    await ts.replaceDerived([["global", [3, 1]]], null);
    expect(await ts.getCounters("global", 2)).toEqual([3, 1]);
    expect(await ts.getCounters("stale", 2)).toEqual([0, 0]);
    expect(await ts.getBlob()).toBeNull();
    // Version keeps advancing so racing CAS writers still fail cleanly.
    expect(await ts.putBlob("new", 0)).toBe(false);
  });
});
