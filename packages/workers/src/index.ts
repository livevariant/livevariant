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
  ModelCache,
  TestService,
  type RequestIdentity,
  type ServingParams,
  type StateStore,
  type TestBackend,
  type TestPolicy,
  type TestShape
} from "@livevariant/server";
import { R2AssetStore } from "./r2-asset-store.js";
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
  /**
   * Decoded-model cache for this object's lifetime. The DO is exactly
   * the place such a cache belongs: single-threaded, long-lived, and
   * every request for its test lands here, so the blob decode happens
   * once per model version instead of once per request.
   */
  private modelCache = new ModelCache();

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
      getPolicy: () => store.getPolicy(),
      updatePolicy: (_t, patch) => store.updatePolicy(patch),
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
    return new TestService(
      this.localStore(testId),
      mulberry32(randomSeed()),
      this.modelCache
    );
  }

  // ---- whole operations: one RPC per serving request ----

  checkShape(params: ServingParams, authoritative: boolean): Promise<boolean> {
    return this.service(params.testId).checkShape(params, authoritative);
  }

  assign(
    params: ServingParams,
    identity: RequestIdentity
  ): Promise<{ cell: number; created: boolean }> {
    return this.service(params.testId).assign(params, identity);
  }

  rewardAssignment(
    testId: string,
    idHash: string,
    amount: number
  ): Promise<{ cell: number; first: boolean } | null> {
    return this.service(testId).reward(testId, idHash, amount);
  }

  recompute(params: ServingParams): Promise<number> {
    return this.service(params.testId).recompute(params);
  }

  stats(
    params: ServingParams,
    labels?: Array<{ key: string; variants: string[] }>
  ) {
    return this.service(params.testId).stats(params, labels);
  }

  updatePolicy(testId: string, patch: TestPolicy): Promise<TestPolicy> {
    return this.service(testId).updatePolicy(testId, patch);
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
  /**
   * Origin to put in the links visitors follow. Unset means every URL is
   * built from the origin the request arrived on, which is all a
   * single-domain deployment needs. Set it when serving has its own
   * domain, to keep bulk email traffic off the dashboard's reputation.
   */
  LV_SERVE_URL?: string;
  /**
   * Image hosting, on only when BOTH are present: the bucket holds the
   * bytes, the secret keys the signed URLs that are the only way to fetch
   * them. Set the secret with `wrangler secret put LV_ASSET_SECRET`
   * (generate one: `openssl rand -hex 32`); leave it unset to run without
   * image hosting even though the bucket binding exists.
   */
  ASSET_STORE?: R2Bucket;
  LV_ASSET_SECRET?: string;
  /** Optional bearer token gating POST /assets; unset means open uploads. */
  LV_ASSET_UPLOAD_TOKEN?: string;
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

  stats(
    params: ServingParams,
    labels?: Array<{ key: string; variants: string[] }>
  ) {
    return this.stub(params.testId).stats(params, labels);
  }

  updatePolicy(testId: string, patch: TestPolicy) {
    return this.stub(testId).updatePolicy(testId, patch);
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
        serveUrl: env.LV_SERVE_URL,
        assets:
          env.ASSET_STORE && env.LV_ASSET_SECRET
            ? {
                store: new R2AssetStore(env.ASSET_STORE),
                signingSecret: env.LV_ASSET_SECRET,
                uploadToken: env.LV_ASSET_UPLOAD_TOKEN
              }
            : undefined
      });
      apps.set(env, app);
    }
    return app.fetch(request);
  }
};
