import { describe, expect, it } from "vitest";
import { mulberry32 } from "@livevariant/core";
import { TestService, type ServingParams } from "./service.js";
import { MemoryStore } from "./store/memory.js";

const PARAMS: ServingParams = {
  testId: "a".repeat(64),
  slotSizes: [2],
  dim: 16
};

describe("model CAS discipline", () => {
  it("reads the blob exactly once per update attempt", async () => {
    // Regression: the update loop used to read the blob twice (once for
    // the version, once for the model). A concurrent writer landing
    // between the reads made every CAS fail as stale with no genuine
    // conflict, and sustained traffic could burn the whole retry budget
    // on phantom races, silently dropping observations. One read must
    // supply both the model and the version its write presents.
    const store = new MemoryStore();
    let reads = 0;
    const countingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "getBlob") {
          return (key: string) => {
            reads++;
            return target.getBlob(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    const service = new TestService(countingStore, mulberry32(7));

    // First id'd assign: one read to serve (loadState) and one inside
    // the pull's update attempt. Anything more is the two-read bug.
    await service.assign(PARAMS, {
      idHash: "b".repeat(64),
      ctxKey: null,
      featIdx: [0]
    });
    expect(reads).toBe(2);

    // The update landed despite the counter proxy: CAS succeeded on the
    // version the single read returned.
    const blob = await store.getBlob(`m:${PARAMS.testId}`);
    expect(blob).not.toBeNull();
    expect(blob!.version).toBe(1);
  });

  it("still lands an update when a writer races every attempt's read", async () => {
    // The honest concurrent case: the version moves AFTER our read, so
    // the first CAS genuinely fails, and the retry (with a fresh single
    // read) succeeds. Before the fix this scenario could fail forever,
    // because the version token was always one write behind the data.
    const store = new MemoryStore();
    let interfere = 1;
    const racingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "getBlob") {
          return async (key: string) => {
            const blob = await target.getBlob(key);
            if (interfere > 0) {
              interfere--;
              // A concurrent writer lands right after our read.
              await target.putBlob(
                key,
                blob?.data ?? JSON.stringify({}),
                blob?.version ?? 0
              );
            }
            return blob;
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    const service = new TestService(racingStore, mulberry32(7));
    await service.assign(PARAMS, {
      idHash: "c".repeat(64),
      ctxKey: null,
      featIdx: [0]
    });
    const blob = await store.getBlob(`m:${PARAMS.testId}`);
    // Interferer wrote once, our update retried and landed on top.
    expect(blob!.version).toBeGreaterThanOrEqual(2);
  });
});
