import { DurableObject } from "cloudflare:workers";
import {
  mulberry32,
  randomSeed,
  type AssignmentRecord,
  type CtxDim,
  type TestRegion
} from "@livevariant/core";
import {
  createApp,
  counterKey,
  type AppOptions,
  derivedToArtifacts,
  ModelCache,
  TestService,
  unlistedDestinationMode,
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
      addReward: (_t, idHash, amount, sdk) =>
        store.addReward(idHash, amount, sdk),
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
    identity: RequestIdentity,
    meta?: { sdk?: string }
  ): Promise<{ cell: number; created: boolean }> {
    return this.service(params.testId).assign(params, identity, meta);
  }

  rewardAssignment(
    testId: string,
    idHash: string,
    amount: number,
    sdk?: string
  ): Promise<{ cell: number; first: boolean } | null> {
    return this.service(testId).reward(testId, idHash, amount, undefined, sdk);
  }

  recompute(params: ServingParams): Promise<number> {
    return this.service(params.testId).recompute(params);
  }

  stats(
    params: ServingParams,
    labels?: Array<{ key: string; variants: string[] }>,
    ctxDims?: CtxDim[]
  ) {
    return this.service(params.testId).stats(params, labels, ctxDims);
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

export interface Env {
  TEST_STATE: DurableObjectNamespace<TestStateDO>;
  /**
   * The static site (wrangler's assets binding). The worker runs first
   * on "/" to give agents markdown negotiation and Link headers; this
   * is how browsers still get the app shell.
   */
  ASSETS?: Fetcher;
  /** Comma-separated destination hosts; a host admits its subdomains. */
  LV_ALLOWED_DESTINATIONS?: string;
  /**
   * Comma-separated page origins allowed to drive tests through the SDK
   * (/choose, /reward). Unset means any origin. Entries are origins or
   * bare hostnames; a hostname admits its subdomains.
   */
  LV_ALLOWED_ORIGINS?: string;
  /**
   * What redirects do with a destination LV_ALLOWED_DESTINATIONS does
   * not name: "allow", "block", or "interstitial" (an explicit
   * "Redirecting you to…" continue screen). Unset keeps the classic
   * defaults: allow-all with no list, block-unlisted with one.
   */
  LV_UNLISTED_DESTINATIONS?: string;
  /**
   * Origin to put in the links visitors follow. Unset means every URL is
   * built from the origin the request arrived on, which is all a
   * single-domain deployment needs. Set it when serving has its own
   * domain, to keep bulk email traffic off the dashboard's reputation.
   */
  LV_SERVE_URL?: string;
  /**
   * The dashboard's canonical origin, e.g. https://livevariant.com. Set
   * it when the deployment answers on more than one hostname (the hosted
   * service also answers on its serving domain), so the shell's pages
   * carry a canonical link and the crawl documents name one address.
   * Unset is the one-domain deployment: nothing changes.
   */
  LV_APP_URL?: string;
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
  /**
   * Self-host machine credential: when set, the tool API (/api/v1) and
   * /mcp require it as a Bearer token. The hosted deployment must not
   * set it ("operator" is the wrong granularity for multi-tenant).
   */
  LV_API_TOKEN?: string;
  /** GTM container id (GTM-XXXXXXX) for the dashboard pages. */
  LV_GOOGLE_TAG_MANAGER?: string;
  /** The deployment's own publishable key, for the landing's test. */
  LV_PUBLISHABLE_KEY?: string;
  /** "off" disables the first-party lv_uid cookie (cookieless mode). */
  LV_BROWSER_ID_COOKIE?: string;
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

  /**
   * Region decides which object a test lives in and where.
   *
   * - A location HINT steers where the object is CREATED (its id is the
   *   plain testId either way, so the hint is placement advice that is
   *   ignored once the object exists). Without one, the object is born
   *   wherever the first request came from, which for an email test is
   *   routinely a mail proxy's datacenter rather than the audience.
   * - "eu" addresses the EU-JURISDICTION namespace: a DIFFERENT object
   *   for the same name, guaranteed created and kept inside the EU.
   *   That is why region is part of the test's identity and rides on
   *   config-free calls (reward): every path must reach the same home.
   */
  private stub(testId: string, region?: TestRegion) {
    if (region === "eu") {
      const ns = this.ns.jurisdiction("eu");
      return ns.get(ns.idFromName(testId));
    }
    return this.ns.get(this.ns.idFromName(testId), {
      locationHint: region
    });
  }

  checkShape(params: ServingParams, authoritative: boolean) {
    return this.stub(params.testId, params.region).checkShape(
      params,
      authoritative
    );
  }

  assign(
    params: ServingParams,
    identity: RequestIdentity,
    meta?: { sdk?: string }
  ) {
    return this.stub(params.testId, params.region).assign(
      params,
      identity,
      meta
    );
  }

  reward(
    testId: string,
    idHash: string,
    amount: number,
    region?: TestRegion,
    sdk?: string
  ) {
    return this.stub(testId, region).rewardAssignment(
      testId,
      idHash,
      amount,
      sdk
    );
  }

  recompute(params: ServingParams) {
    return this.stub(params.testId, params.region).recompute(params);
  }

  stats(
    params: ServingParams,
    labels?: Array<{ key: string; variants: string[] }>,
    ctxDims?: CtxDim[]
  ) {
    return this.stub(params.testId, params.region).stats(
      params,
      labels,
      ctxDims
    );
  }

  updatePolicy(testId: string, patch: TestPolicy, region?: TestRegion) {
    return this.stub(testId, region).updatePolicy(testId, patch);
  }
}

/** Comma-separated env var to list; blank means unset (deploy button). */
function listVar(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(",")
    .map(h => h.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}

/**
 * The AppOptions every entry shares. The hosted entry (index.hosted.ts)
 * layers accounts on top of exactly this, so the two cannot drift.
 */
export function baseAppOptions(env: Env): AppOptions {
  return {
    backend: new DurableObjectBackend(env.TEST_STATE),
    allowedDestinations: listVar(env.LV_ALLOWED_DESTINATIONS),
    allowedOrigins: listVar(env.LV_ALLOWED_ORIGINS),
    unlistedDestinations: unlistedDestinationMode(env.LV_UNLISTED_DESTINATIONS),
    serveUrl: env.LV_SERVE_URL,
    appUrl: env.LV_APP_URL,
    apiToken: env.LV_API_TOKEN,
    gtmId: env.LV_GOOGLE_TAG_MANAGER,
    publishableKey: env.LV_PUBLISHABLE_KEY,
    browserIdCookie: env.LV_BROWSER_ID_COOKIE !== "off",
    spaFetch: env.ASSETS
      ? (request: Request) => env.ASSETS!.fetch(request)
      : undefined,
    assets:
      env.ASSET_STORE && env.LV_ASSET_SECRET
        ? {
            store: new R2AssetStore(env.ASSET_STORE),
            signingSecret: env.LV_ASSET_SECRET,
            uploadToken: env.LV_ASSET_UPLOAD_TOKEN
          }
        : undefined
  };
}

// One app per env (i.e. per isolate in practice): route registration and
// middleware chains are not free, and the binding object is stable across
// requests, so rebuilding the app each request is pure waste.
const apps = new WeakMap<Env, ReturnType<typeof createApp>>();

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Response | Promise<Response> {
    let app = apps.get(env);
    if (!app) {
      app = createApp(baseAppOptions(env));
      apps.set(env, app);
    }
    // The ExecutionContext must travel: without it Hono's
    // c.executionCtx throws, waitUntil never engages, and any work
    // scheduled past the response (registration) dies at its first
    // await when the invocation ends.
    return app.fetch(request, env, ctx);
  }
};
