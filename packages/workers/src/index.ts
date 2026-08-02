import { DurableObject } from "cloudflare:workers";
import type { AssignmentRecord, DerivedState } from "@livevariant/core";
import {
  createApp,
  counterKey,
  derivedToArtifacts,
  type StateStore
} from "@livevariant/server";
import { TestStorage } from "./test-storage.js";

/**
 * Cloudflare deployment: the Hono app from @livevariant/server, backed by
 * one SQLite Durable Object per testId. The DO gives per-test serial
 * execution, so this adapter needs none of the Redis adapter's scripting.
 */

export class TestStateDO extends DurableObject {
  private store = new TestStorage({
    get: key => this.ctx.storage.get(key),
    put: (key, value) => this.ctx.storage.put(key, value),
    delete: key => this.ctx.storage.delete(key),
    deleteMany: keys => this.ctx.storage.delete(keys),
    list: async options => this.ctx.storage.list(options)
  });

  getAssignment(idHash: string): Promise<AssignmentRecord | null> {
    return this.store.getAssignment(idHash);
  }

  putAssignmentIfAbsent(
    idHash: string,
    rec: AssignmentRecord
  ): Promise<{ rec: AssignmentRecord; created: boolean }> {
    return this.store.putAssignmentIfAbsent(idHash, rec);
  }

  addReward(
    idHash: string,
    amount: number
  ): Promise<{ rec: AssignmentRecord; first: boolean } | null> {
    return this.store.addReward(idHash, amount);
  }

  listAssignments(
    startAfter: string | null,
    limit: number
  ): Promise<{ records: AssignmentRecord[]; nextStartAfter: string | null }> {
    return this.store.listAssignments(startAfter, limit);
  }

  incrCounters(scope: string, deltas: number[]): Promise<void> {
    return this.store.incrCounters(scope, deltas);
  }

  getCounters(scope: string, length: number): Promise<number[]> {
    return this.store.getCounters(scope, length);
  }

  getBlob(): Promise<{ data: string; version: number } | null> {
    return this.store.getBlob();
  }

  putBlob(data: string, expectedVersion: number): Promise<boolean> {
    return this.store.putBlob(data, expectedVersion);
  }

  replaceDerived(
    counters: Array<[string, number[]]>,
    blob: string | null
  ): Promise<void> {
    return this.store.replaceDerived(counters, blob);
  }
}

interface Env {
  TEST_STATE: DurableObjectNamespace<TestStateDO>;
}

/** StateStore that forwards each call to the test's Durable Object. */
class DurableObjectStore implements StateStore {
  constructor(private ns: DurableObjectNamespace<TestStateDO>) {}

  private stub(testId: string) {
    return this.ns.get(this.ns.idFromName(testId));
  }

  /** Counter/blob keys arrive as c:{testId}:{scope} / l:{testId}. */
  private parseKey(key: string): { testId: string; scope: string } {
    const [, testId, ...rest] = key.split(":");
    return { testId, scope: rest.join(":") };
  }

  getAssignment(testId: string, idHash: string) {
    return this.stub(testId).getAssignment(idHash);
  }

  putAssignmentIfAbsent(testId: string, idHash: string, rec: AssignmentRecord) {
    return this.stub(testId).putAssignmentIfAbsent(idHash, rec);
  }

  addReward(testId: string, idHash: string, amount: number) {
    return this.stub(testId).addReward(idHash, amount);
  }

  async *scanAssignments(testId: string): AsyncIterable<AssignmentRecord> {
    let startAfter: string | null = null;
    do {
      const page: {
        records: AssignmentRecord[];
        nextStartAfter: string | null;
      } = await this.stub(testId).listAssignments(startAfter, 500);
      for (const rec of page.records) {
        yield rec;
      }
      startAfter = page.nextStartAfter;
    } while (startAfter !== null);
  }

  incrCounters(key: string, deltas: number[]) {
    const { testId, scope } = this.parseKey(key);
    return this.stub(testId).incrCounters(scope, deltas);
  }

  getCounters(key: string, length: number) {
    const { testId, scope } = this.parseKey(key);
    return this.stub(testId).getCounters(scope, length);
  }

  getBlob(key: string) {
    return this.stub(this.parseKey(key).testId).getBlob();
  }

  putBlob(key: string, data: string, expectedVersion: number) {
    return this.stub(this.parseKey(key).testId).putBlob(data, expectedVersion);
  }

  async replaceDerived(testId: string, state: DerivedState): Promise<void> {
    const { counters, blob } = derivedToArtifacts(testId, state);
    // The DO stores scopes, not full keys: strip the c:{testId}: prefix.
    const scoped: Array<[string, number[]]> = [...counters.entries()].map(
      ([key, values]) => [key.slice(counterKey(testId, "").length), values]
    );
    await this.stub(testId).replaceDerived(scoped, blob);
  }
}

// One app per env (i.e. per isolate in practice): route registration and
// middleware chains are not free, and the binding object is stable across
// requests, so rebuilding the app each request is pure waste.
const apps = new WeakMap<Env, ReturnType<typeof createApp>>();

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    let app = apps.get(env);
    if (!app) {
      app = createApp({ store: new DurableObjectStore(env.TEST_STATE) });
      apps.set(env, app);
    }
    return app.fetch(request);
  }
};
