import type { AssignmentRecord } from "@livevariant/core";

/**
 * The per-test state logic that runs INSIDE the Durable Object, written
 * against a minimal storage interface so it is unit-testable in Node.
 * The DO serializes all access to one test, so unlike the Redis adapter
 * nothing here needs scripts or CAS loops: plain read-modify-write is
 * already atomic.
 */
export interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Batch form: one round-trip for many keys (DO storage supports this). */
  deleteMany(keys: string[]): Promise<number>;
  list<T>(options: {
    prefix: string;
    startAfter?: string;
    limit?: number;
  }): Promise<Map<string, T>>;
}

const ASSIGNMENT_PREFIX = "a:";
const COUNTER_PREFIX = "c:";
const BLOB_KEY = "l";
const SHAPE_KEY = "shape";
const POLICY_KEY = "policy";
/** Cloudflare caps a single storage delete() at 128 keys. */
const DELETE_BATCH = 128;

export interface TestShape {
  armCount: number;
  alg: "ts" | "bucketed" | "linear";
  dim: number;
}

export interface TestPolicy {
  shape?: TestShape;
  excludedSources?: string[];
  excludedWindows?: Array<{ since: number; until: number }>;
}

/** data:null means "no blob", but the version keeps advancing so that a
 * racing CAS writer holding an old version still fails. */
interface BlobEnvelope {
  version: number;
  data: string | null;
}

export class TestStorage {
  constructor(private storage: StorageLike) {}

  async getAssignment(idHash: string): Promise<AssignmentRecord | null> {
    return (
      (await this.storage.get<AssignmentRecord>(ASSIGNMENT_PREFIX + idHash)) ??
      null
    );
  }

  async putAssignmentIfAbsent(
    idHash: string,
    rec: AssignmentRecord
  ): Promise<{ rec: AssignmentRecord; created: boolean }> {
    const existing = await this.getAssignment(idHash);
    if (existing) {
      return { rec: existing, created: false };
    }
    await this.storage.put(ASSIGNMENT_PREFIX + idHash, rec);
    return { rec, created: true };
  }

  async addReward(
    idHash: string,
    amount: number
  ): Promise<{ rec: AssignmentRecord; first: boolean } | null> {
    const rec = await this.getAssignment(idHash);
    if (!rec) {
      return null;
    }
    const first = rec.rewardTotal === 0;
    rec.rewardTotal += amount;
    await this.storage.put(ASSIGNMENT_PREFIX + idHash, rec);
    return { rec, first };
  }

  async listAssignments(
    startAfter: string | null,
    limit: number
  ): Promise<{ records: AssignmentRecord[]; nextStartAfter: string | null }> {
    const entries = await this.storage.list<AssignmentRecord>({
      prefix: ASSIGNMENT_PREFIX,
      startAfter: startAfter ?? undefined,
      limit
    });
    const keys = [...entries.keys()];
    return {
      records: [...entries.values()],
      nextStartAfter:
        keys.length === limit ? (keys[keys.length - 1] ?? null) : null
    };
  }

  async incrCounters(scope: string, deltas: number[]): Promise<void> {
    const key = COUNTER_PREFIX + scope;
    const current = (await this.storage.get<number[]>(key)) ?? [];
    for (let i = 0; i < deltas.length; i++) {
      current[i] = (current[i] ?? 0) + deltas[i];
    }
    await this.storage.put(key, current);
  }

  async getCounters(scope: string, length: number): Promise<number[]> {
    const current =
      (await this.storage.get<number[]>(COUNTER_PREFIX + scope)) ?? [];
    return Array.from({ length }, (_, i) => current[i] ?? 0);
  }

  /** Shape pinning; the config-derived call is authoritative. */
  async pinShape(shape: TestShape, authoritative: boolean): Promise<TestShape> {
    const existing = await this.storage.get<TestShape>(SHAPE_KEY);
    if (existing && !authoritative) {
      return existing;
    }
    await this.storage.put(SHAPE_KEY, shape);
    return shape;
  }

  async getPolicy(): Promise<TestPolicy> {
    return (await this.storage.get<TestPolicy>(POLICY_KEY)) ?? {};
  }

  async updatePolicy(patch: TestPolicy): Promise<TestPolicy> {
    const merged = { ...(await this.getPolicy()), ...patch };
    await this.storage.put(POLICY_KEY, merged);
    return merged;
  }

  /**
   * Per-source tally for the live cap, kept in the object's memory rather
   * than its storage: this is a guard that stops an in-flight flood from
   * moving the model, not the authority on what counts (capContributions
   * at recompute/stats time is). Persisting it would add storage ops to
   * every assignment on the hot path to protect a number that may safely
   * reset when the object is evicted.
   */
  private sourceCounts = new Map<string, number>();
  private sourceTotal = 0;

  async noteSource(
    srcHash: string
  ): Promise<{ sourceCount: number; totalCount: number }> {
    const sourceCount = (this.sourceCounts.get(srcHash) ?? 0) + 1;
    this.sourceCounts.set(srcHash, sourceCount);
    this.sourceTotal += 1;
    return { sourceCount, totalCount: this.sourceTotal };
  }

  /**
   * Fixed-window request count. The DO is a single instance per test, so
   * unlike an isolate-local map this is a true global counter.
   */
  private requestWindows = new Map<
    string,
    { count: number; windowStart: number }
  >();

  async noteRequest(bucket: string, now: number): Promise<{ count: number }> {
    const entry = this.requestWindows.get(bucket);
    if (!entry || now - entry.windowStart >= 60_000) {
      if (this.requestWindows.size > 5_000) {
        this.requestWindows.clear();
      }
      this.requestWindows.set(bucket, { count: 1, windowStart: now });
      return { count: 1 };
    }
    entry.count += 1;
    return { count: entry.count };
  }

  // Blob and version live in ONE key: two keys doubled the billed storage
  // ops on the linear hot path for no benefit.
  async getBlob(): Promise<{ data: string; version: number } | null> {
    const envelope = await this.storage.get<BlobEnvelope>(BLOB_KEY);
    return envelope?.data != null
      ? { data: envelope.data, version: envelope.version }
      : null;
  }

  async putBlob(data: string, expectedVersion: number): Promise<boolean> {
    const envelope = await this.storage.get<BlobEnvelope>(BLOB_KEY);
    const current = envelope?.version ?? 0;
    if (current !== expectedVersion) {
      return false;
    }
    await this.storage.put(BLOB_KEY, { version: current + 1, data });
    return true;
  }

  /** Replaces derived artifacts; DerivedState arrives pre-serialized. */
  async replaceDerived(
    counters: Array<[scope: string, values: number[]]>,
    blob: string | null
  ): Promise<void> {
    const stale = await this.storage.list<number[]>({
      prefix: COUNTER_PREFIX
    });
    // Chunked: DO storage rejects a delete() of more than 128 keys, which
    // a test with many context buckets would hit.
    const staleKeys = [...stale.keys()];
    for (let i = 0; i < staleKeys.length; i += DELETE_BATCH) {
      await this.storage.deleteMany(staleKeys.slice(i, i + DELETE_BATCH));
    }
    for (const [scope, values] of counters) {
      await this.storage.put(COUNTER_PREFIX + scope, values);
    }
    const envelope = await this.storage.get<BlobEnvelope>(BLOB_KEY);
    await this.storage.put(BLOB_KEY, {
      version: (envelope?.version ?? 0) + 1,
      data: blob
    });
  }
}
