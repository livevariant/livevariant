import { afterAll, describe, expect, it } from "vitest";
import type { AssignmentRecord } from "@livevariant/core";
import { MemoryStore } from "./memory.js";
import { RedisStore } from "./redis.js";
import {
  counterKey,
  GLOBAL_SCOPE,
  linearKey,
  type StateStore
} from "./types.js";

/**
 * Contract every adapter must satisfy. Memory always runs; Redis runs when
 * REDIS_URL is set (CI provides a redis service container).
 */

let seq = 0;
function freshTestId(): string {
  // Unique per test case so adapters with shared backends don't collide.
  return (seq++).toString(16).padStart(8, "0").repeat(8);
}

function rec(
  armIndex: number,
  extra?: Partial<AssignmentRecord>
): AssignmentRecord {
  return {
    armIndex,
    ctxKey: null,
    featIdx: [0],
    rewardTotal: 0,
    firstSeen: Date.now(),
    ...extra
  };
}

function contract(name: string, getStore: () => StateStore): void {
  describe(name, () => {
    it("creates an assignment once and returns the winner after", async () => {
      const store = getStore();
      const testId = freshTestId();
      const first = await store.putAssignmentIfAbsent(testId, "id1", rec(0));
      expect(first.created).toBe(true);
      const second = await store.putAssignmentIfAbsent(testId, "id1", rec(1));
      expect(second.created).toBe(false);
      expect(second.rec.armIndex).toBe(0);
      expect((await store.getAssignment(testId, "id1"))?.armIndex).toBe(0);
    });

    it("resolves same-id races to exactly one winner", async () => {
      const store = getStore();
      const testId = freshTestId();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.putAssignmentIfAbsent(testId, "raced", rec(i % 3))
        )
      );
      expect(results.filter(r => r.created)).toHaveLength(1);
      const winner = results.find(r => r.created)?.rec.armIndex;
      for (const r of results) {
        expect(r.rec.armIndex).toBe(winner);
      }
    });

    it("drops rewards without an assignment", async () => {
      const store = getStore();
      expect(await store.addReward(freshTestId(), "ghost", 1)).toBeNull();
    });

    it("flags only the first reward and accumulates the rest", async () => {
      const store = getStore();
      const testId = freshTestId();
      await store.putAssignmentIfAbsent(testId, "id1", rec(2));
      const a = await store.addReward(testId, "id1", 1);
      const b = await store.addReward(testId, "id1", 2.5);
      expect(a?.first).toBe(true);
      expect(b?.first).toBe(false);
      expect(b?.rec.rewardTotal).toBeCloseTo(3.5);
      expect(b?.rec.armIndex).toBe(2);
    });

    it("scans every assignment", async () => {
      const store = getStore();
      const testId = freshTestId();
      for (let i = 0; i < 25; i++) {
        await store.putAssignmentIfAbsent(testId, `id${i}`, rec(i % 2));
      }
      const seen: number[] = [];
      for await (const r of store.scanAssignments(testId)) {
        seen.push(r.armIndex);
      }
      expect(seen).toHaveLength(25);
    });

    it("increments counters atomically under concurrency", async () => {
      const store = getStore();
      const key = counterKey(freshTestId(), GLOBAL_SCOPE);
      await Promise.all(
        Array.from({ length: 50 }, () => store.incrCounters(key, [1, 0, 0, 1]))
      );
      expect(await store.getCounters(key, 4)).toEqual([50, 0, 0, 50]);
    });

    it("zero-fills missing counters", async () => {
      const store = getStore();
      expect(
        await store.getCounters(counterKey(freshTestId(), GLOBAL_SCOPE), 4)
      ).toEqual([0, 0, 0, 0]);
    });

    it("enforces compare-and-set on blobs", async () => {
      const store = getStore();
      const key = linearKey(freshTestId());
      expect(await store.getBlob(key)).toBeNull();
      expect(await store.putBlob(key, "v1", 0)).toBe(true);
      expect(await store.putBlob(key, "stale", 0)).toBe(false);
      const blob = await store.getBlob(key);
      expect(blob?.data).toBe("v1");
      expect(await store.putBlob(key, "v2", blob!.version)).toBe(true);
      expect((await store.getBlob(key))?.data).toBe("v2");
    });

    it("replaces derived state wholesale", async () => {
      const store = getStore();
      const testId = freshTestId();
      // Stale artifacts that the snapshot must wipe.
      await store.incrCounters(counterKey(testId, "stalebucket"), [9, 9]);
      await store.incrCounters(counterKey(testId, GLOBAL_SCOPE), [9, 9, 9, 9]);
      await store.replaceDerived(testId, {
        alg: "bucketed",
        global: [
          { pulls: 3, successes: 1 },
          { pulls: 4, successes: 2 }
        ],
        buckets: {
          bucketA: [
            { pulls: 1, successes: 0 },
            { pulls: 2, successes: 1 }
          ]
        }
      });
      expect(
        await store.getCounters(counterKey(testId, GLOBAL_SCOPE), 4)
      ).toEqual([3, 1, 4, 2]);
      expect(await store.getCounters(counterKey(testId, "bucketA"), 4)).toEqual(
        [1, 0, 2, 1]
      );
      expect(
        await store.getCounters(counterKey(testId, "stalebucket"), 2)
      ).toEqual([0, 0]);
    });
  });
}

const memory = new MemoryStore();
contract("MemoryStore", () => memory);

const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  const redis = await RedisStore.connect(redisUrl);
  afterAll(() => redis.close());
  contract("RedisStore", () => redis);
} else {
  describe.skip("RedisStore (set REDIS_URL to run)", () => {
    it("skipped", () => {});
  });
}
