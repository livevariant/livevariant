import { describe, expect, it } from "vitest";
import type { AssignmentRecord } from "@livevariant/core";
import {
  counterKey,
  GLOBAL_SCOPE,
  modelKey,
  type StateStore
} from "./types.js";

/**
 * The conformance suite every StateStore adapter must pass, importable as
 * `@livevariant/server/testing` so an adapter's own repository can run it:
 *
 *   import { storeContract } from "@livevariant/server/testing";
 *   storeContract("PostgresStore", () => new PostgresStore(pool));
 *
 * It needs vitest, which is why it lives behind its own entry point
 * instead of the package root.
 *
 * The single-threaded tests define what the methods mean. The concurrency
 * tests are the reason this suite exists at all: an adapter written as
 * read-modify-write over a plain KV passes every sequential test and then
 * corrupts state under real traffic. Against MemoryStore (synchronous)
 * those tests interleave nothing and prove little; against any adapter
 * doing genuine async I/O, every `await` is a seam where a lost update
 * shows up as a failed assertion.
 *
 * What must hold, and what happens when it does not:
 *
 * - `putAssignmentIfAbsent` atomic: otherwise one visitor is told two
 *   different variants, and no recompute can repair it, because the
 *   assignment log IS the source of truth.
 * - `addReward` atomic per record: otherwise concurrent conversions lose
 *   revenue, also unrepairably.
 * - `incrCounters` a true increment and `putBlob` a true compare-and-swap:
 *   failures here corrupt only the derived cache, which `recompute`
 *   rebuilds from the log. Wrong until healed, not wrong forever.
 */
export function storeContract(
  name: string,
  getStore: () => StateStore | Promise<StateStore>
): void {
  // Random, not sequential: adapter authors run this against persistent
  // backends, where ids from the previous run are still on disk.
  function freshTestId(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function rec(
    cell: number,
    extra?: Partial<AssignmentRecord>
  ): AssignmentRecord {
    return {
      cell,
      slotSizes: [3],
      dim: 16,
      featIdx: [0],
      ctxKey: null,
      rewardTotal: 0,
      firstSeen: 1700000000000,
      ...extra
    };
  }

  describe(name, () => {
    it("creates an assignment once and returns the winner after", async () => {
      const store = await getStore();
      const testId = freshTestId();
      const first = await store.putAssignmentIfAbsent(testId, "id1", rec(0));
      expect(first.created).toBe(true);
      const second = await store.putAssignmentIfAbsent(testId, "id1", rec(1));
      expect(second.created).toBe(false);
      expect(second.rec.cell).toBe(0);
      expect((await store.getAssignment(testId, "id1"))?.cell).toBe(0);
    });

    it("resolves same-id races to exactly one winner", async () => {
      // The unrepairable one: a visitor who gets two variants poisons the
      // test in a way no recompute can undo. INSERT-if-absent must be a
      // single atomic operation, never a read followed by a write.
      const store = await getStore();
      const testId = freshTestId();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.putAssignmentIfAbsent(testId, "raced", rec(i % 3))
        )
      );
      expect(results.filter(r => r.created)).toHaveLength(1);
      const winner = results.find(r => r.created)?.rec.cell;
      for (const r of results) {
        expect(r.rec.cell).toBe(winner);
      }
    });

    it("drops rewards without an assignment", async () => {
      const store = await getStore();
      expect(await store.addReward(freshTestId(), "ghost", 1)).toBeNull();
    });

    it("flags only the first reward and accumulates the rest", async () => {
      const store = await getStore();
      const testId = freshTestId();
      await store.putAssignmentIfAbsent(testId, "id1", rec(2));
      const a = await store.addReward(testId, "id1", 1);
      const b = await store.addReward(testId, "id1", 2.5);
      expect(a?.first).toBe(true);
      expect(b?.first).toBe(false);
      expect(b?.rec.rewardTotal).toBeCloseTo(3.5);
      expect(b?.rec.cell).toBe(2);
    });

    it("loses no rewards under concurrency, and firsts exactly one", async () => {
      // A get-then-put adapter passes the sequential test above and fails
      // here: two reads of the same rewardTotal collapse two conversions
      // into one. Rewards are part of the event log, so this loss is
      // permanent. `first` doubles as the only-once trigger for updating
      // derived success counts, so exactly one caller may see it.
      const store = await getStore();
      const testId = freshTestId();
      await store.putAssignmentIfAbsent(testId, "buyer", rec(1));
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.addReward(testId, "buyer", 1))
      );
      expect(results.filter(r => r?.first)).toHaveLength(1);
      expect(
        (await store.getAssignment(testId, "buyer"))?.rewardTotal
      ).toBeCloseTo(20);
    });

    it("scans every assignment", async () => {
      const store = await getStore();
      const testId = freshTestId();
      for (let i = 0; i < 25; i++) {
        await store.putAssignmentIfAbsent(testId, `id${i}`, rec(i % 2));
      }
      const seen: number[] = [];
      for await (const r of store.scanAssignments(testId)) {
        seen.push(r.cell);
      }
      expect(seen).toHaveLength(25);
    });

    it("keeps tests isolated from each other", async () => {
      // Every method is namespaced by testId; a scan that leaks a
      // neighbouring test's records would let one recompute rewrite
      // another test's model.
      const store = await getStore();
      const a = freshTestId();
      const b = freshTestId();
      await store.putAssignmentIfAbsent(a, "id1", rec(0));
      await store.putAssignmentIfAbsent(b, "id1", rec(1));
      const seen: number[] = [];
      for await (const r of store.scanAssignments(a)) {
        seen.push(r.cell);
      }
      expect(seen).toEqual([0]);
      expect((await store.getAssignment(b, "id1"))?.cell).toBe(1);
    });

    it("increments counters atomically under concurrency", async () => {
      // Derived cache: a lost increment here skews serving until the next
      // recompute, which is survivable, and still not acceptable as a
      // steady state. Must be an atomic increment, not read-modify-write.
      const store = await getStore();
      const key = counterKey(freshTestId(), GLOBAL_SCOPE);
      await Promise.all(
        Array.from({ length: 50 }, () => store.incrCounters(key, [1, 0, 0, 1]))
      );
      expect(await store.getCounters(key, 4)).toEqual([50, 0, 0, 50]);
    });

    it("zero-fills missing counters", async () => {
      const store = await getStore();
      expect(
        await store.getCounters(counterKey(freshTestId(), GLOBAL_SCOPE), 4)
      ).toEqual([0, 0, 0, 0]);
    });

    it("enforces compare-and-set on blobs", async () => {
      const store = await getStore();
      const key = modelKey(freshTestId());
      expect(await store.getBlob(key)).toBeNull();
      expect(await store.putBlob(key, "v1", 0)).toBe(true);
      expect(await store.putBlob(key, "stale", 0)).toBe(false);
      const blob = await store.getBlob(key);
      expect(blob?.data).toBe("v1");
      expect(await store.putBlob(key, "v2", blob!.version)).toBe(true);
      expect((await store.getBlob(key))?.data).toBe("v2");
    });

    it("admits exactly one writer per blob version", async () => {
      // The linear model's update loop is read, compute, CAS, retry. If
      // two writers can both succeed at the same expectedVersion, one
      // observation silently vanishes into the other's overwrite.
      const store = await getStore();
      const key = modelKey(freshTestId());
      expect(await store.putBlob(key, "base", 0)).toBe(true);
      const version = (await store.getBlob(key))!.version;
      const wins = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.putBlob(key, `writer${i}`, version)
        )
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
    });

    it("pins a shape on first sight and lets the config override it", async () => {
      const store = await getStore();
      const testId = freshTestId();
      const first = await store.pinShape(
        testId,
        { slotSizes: [2], dim: 16 },
        false
      );
      expect(first.slotSizes).toEqual([2]);
      // A non-authoritative caller claiming a different shape sees the pin.
      const claimed = await store.pinShape(
        testId,
        { slotSizes: [5, 5], dim: 64 },
        false
      );
      expect(claimed).toEqual({ slotSizes: [2], dim: 16 });
      // The decoded config always wins.
      const authoritative = await store.pinShape(
        testId,
        { slotSizes: [3], dim: 16 },
        true
      );
      expect(authoritative.slotSizes).toEqual([3]);
    });

    it("agrees on one shape when first sight is contested", async () => {
      // Shape pinning is the trust control on unauthenticated /choose
      // writes; if racing callers could each pin their own shape, the
      // control pins nothing.
      const store = await getStore();
      const testId = freshTestId();
      const pins = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.pinShape(testId, { slotSizes: [2 + i], dim: 16 }, false)
        )
      );
      const settled = await store.pinShape(
        testId,
        { slotSizes: [99], dim: 16 },
        false
      );
      for (const pin of pins) {
        expect(pin).toEqual(settled);
      }
    });

    it("merges policy patches without dropping absent keys", async () => {
      const store = await getStore();
      const testId = freshTestId();
      expect(await store.getPolicy(testId)).toEqual({});
      await store.updatePolicy(testId, { excludedSources: ["a".repeat(64)] });
      // A patch that says nothing about sources must not erase them.
      const merged = await store.updatePolicy(testId, {
        excludedWindows: [{ since: 1, until: 2 }]
      });
      expect(merged.excludedSources).toEqual(["a".repeat(64)]);
      expect(merged.excludedWindows).toEqual([{ since: 1, until: 2 }]);
      expect(await store.getPolicy(testId)).toEqual(merged);
    });

    it("replaces derived state wholesale", async () => {
      const store = await getStore();
      const testId = freshTestId();
      // Stale artifacts that the snapshot must wipe: recompute is the
      // repair path for every derived-cache failure, so a replace that
      // leaves old buckets behind would make healing impossible.
      await store.incrCounters(counterKey(testId, "stalebucket"), [9, 9]);
      await store.incrCounters(counterKey(testId, GLOBAL_SCOPE), [9, 9, 9, 9]);
      await store.replaceDerived(testId, {
        slotSizes: [2],
        dim: 16,
        cells: [
          { pulls: 3, successes: 1 },
          { pulls: 4, successes: 2 }
        ],
        model: {
          aInv: Array.from({ length: 16 }, (_, i) =>
            Array.from({ length: 16 }, (_, j) => (i === j ? 1 : 0))
          ),
          b: new Array<number>(16).fill(0)
        }
      });
      expect(
        await store.getCounters(counterKey(testId, GLOBAL_SCOPE), 4)
      ).toEqual([3, 1, 4, 2]);
      expect(
        await store.getCounters(counterKey(testId, "stalebucket"), 2)
      ).toEqual([0, 0]);
      // The snapshot's model blob replaces whatever was stored before.
      const blob = await store.getBlob(modelKey(testId));
      expect(blob).not.toBeNull();
      expect(JSON.parse(blob!.data).dim).toBe(16);
    });
  });
}
