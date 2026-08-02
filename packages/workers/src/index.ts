import { DurableObject } from "cloudflare:workers";
import {
  mulberry32,
  randomSeed,
  type AssignmentRecord
} from "@livevariant/core";
import {
  createApp,
  counterKey,
  derivedToArtifacts,
  TestService,
  type RequestIdentity,
  type ServingParams,
  type StateStore,
  type TestBackend,
  type TestShape
} from "@livevariant/server";
import { TestStorage } from "./test-storage.js";

/**
 * Cloudflare deployment: the Hono app from @livevariant/server, backed by
 * one SQLite Durable Object per testId. The DO gives per-test serial
 * execution, so this adapter needs none of the locking or scripting a
 * shared-database backend would.
 *
 * The DO exposes the whole assign/reward operations, not just storage
 * primitives: a Worker running the fine-grained StateStore would pay a
 * separate cross-colo RPC (and a billed DO request) for every read and
 * write, so one serving request became 4-7 round-trips. Running the
 * service inside the object makes it exactly one.
 */

export class TestStateDO extends DurableObject {
  private store = new TestStorage({
    get: key => this.ctx.storage.get(key),
    put: (key, value) => this.ctx.storage.put(key, value),
    delete: key => this.ctx.storage.delete(key),
    deleteMany: keys => this.ctx.storage.delete(keys),
    list: async options => this.ctx.storage.list(options)
  });

  /** Storage confined to this object; the testId is its name. */
  private localStore(testId: string): StateStore {
    const store = this.store;
    return {
      pinShape: (_t, shape, authoritative) =>
        store.pinShape(shape, authoritative),
      getAssignment: (_t, idHash) => store.getAssignment(idHash),
      putAssignmentIfAbsent: (_t, idHash, rec) =>
        store.putAssignmentIfAbsent(idHash, rec),
      addReward: (_t, idHash, amount) => store.addReward(idHash, amount),
      async *scanAssignments() {
        let startAfter: string | null = null;
        do {
          const page: {
            records: AssignmentRecord[];
            nextStartAfter: string | null;
          } = await store.listAssignments(startAfter, 500);
          for (const rec of page.records) {
            yield rec;
          }
          startAfter = page.nextStartAfter;
        } while (startAfter !== null);
      },
      incrCounters: (key, deltas) =>
        store.incrCounters(stripScope(testId, key), deltas),
      getCounters: (key, length) =>
        store.getCounters(stripScope(testId, key), length),
      getBlob: () => store.getBlob(),
      putBlob: (_k, data, expectedVersion) =>
        store.putBlob(data, expectedVersion),
      replaceDerived: async (_t, state) => {
        const { counters, blob } = derivedToArtifacts(testId, state);
        await store.replaceDerived(
          [...counters.entries()].map(([key, values]) => [
            stripScope(testId, key),
            values
          ]),
          blob
        );
      }
    };
  }

  private service(testId: string): TestService {
    return new TestService(this.localStore(testId), mulberry32(randomSeed()));
  }

  // ---- whole operations: one RPC per serving request ----

  checkShape(params: ServingParams, authoritative: boolean): Promise<boolean> {
    return this.service(params.testId).checkShape(params, authoritative);
  }

  assign(
    params: ServingParams,
    identity: RequestIdentity
  ): Promise<{ armIndex: number; created: boolean }> {
    return this.service(params.testId).assign(params, identity);
  }

  rewardAssignment(
    testId: string,
    idHash: string,
    amount: number
  ): Promise<{ armIndex: number; first: boolean } | null> {
    return this.service(testId).reward(testId, idHash, amount);
  }

  recompute(params: ServingParams): Promise<number> {
    return this.service(params.testId).recompute(params);
  }

  stats(params: ServingParams, armNames?: string[]) {
    return this.service(params.testId).stats(params, armNames);
  }

  pinShape(shape: TestShape, authoritative: boolean): Promise<TestShape> {
    return this.store.pinShape(shape, authoritative);
  }

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
  /** Comma-separated destination hosts; unset means allow-all. */
  LV_ALLOWED_DESTINATIONS?: string;
  /** Per-IP per-minute cap on the public write endpoints. */
  LV_RATE_LIMIT_PER_MINUTE?: string;
}

/** Counter keys arrive as c:{testId}:{scope}; the DO stores scopes. */
function stripScope(testId: string, key: string): string {
  return key.slice(counterKey(testId, "").length);
}

/**
 * TestBackend over the DO namespace: one RPC per whole operation, so a
 * serving request is a single cross-colo hop instead of one per storage
 * primitive. The fine-grained StateStore still exists (MemoryStore uses
 * it, and the DO runs the service against its own local storage), so a
 * different backend can be added without touching the HTTP layer.
 */
class DurableObjectBackend implements TestBackend {
  constructor(private ns: DurableObjectNamespace<TestStateDO>) {}

  private stub(testId: string) {
    return this.ns.get(this.ns.idFromName(testId));
  }

  checkShape(params: ServingParams, authoritative: boolean) {
    return this.stub(params.testId).checkShape(params, authoritative);
  }

  assign(params: ServingParams, identity: RequestIdentity) {
    return this.stub(params.testId).assign(params, identity);
  }

  reward(testId: string, idHash: string, amount: number) {
    return this.stub(testId).rewardAssignment(testId, idHash, amount);
  }

  recompute(params: ServingParams) {
    return this.stub(params.testId).recompute(params);
  }

  stats(params: ServingParams, armNames?: string[]) {
    return this.stub(params.testId).stats(params, armNames);
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
      app = createApp({
        backend: new DurableObjectBackend(env.TEST_STATE),
        allowedDestinations: env.LV_ALLOWED_DESTINATIONS
          ? env.LV_ALLOWED_DESTINATIONS.split(",")
              .map(h => h.trim())
              .filter(Boolean)
          : undefined,
        rateLimitPerMinute: Number(env.LV_RATE_LIMIT_PER_MINUTE ?? "120")
      });
      apps.set(env, app);
    }
    return app.fetch(request);
  }
};
