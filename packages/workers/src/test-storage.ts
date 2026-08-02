import type { AssignmentRecord, DerivedState } from "@livevariant/core";

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
  list<T>(options: {
    prefix: string;
    startAfter?: string;
    limit?: number;
  }): Promise<Map<string, T>>;
}

const ASSIGNMENT_PREFIX = "a:";
const COUNTER_PREFIX = "c:";
const BLOB_KEY = "l";
const BLOB_VERSION_KEY = "lv";

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

  async getBlob(): Promise<{ data: string; version: number } | null> {
    const data = await this.storage.get<string>(BLOB_KEY);
    if (data === undefined) {
      return null;
    }
    const version = (await this.storage.get<number>(BLOB_VERSION_KEY)) ?? 0;
    return { data, version };
  }

  async putBlob(data: string, expectedVersion: number): Promise<boolean> {
    const current = (await this.storage.get<number>(BLOB_VERSION_KEY)) ?? 0;
    if (current !== expectedVersion) {
      return false;
    }
    await this.storage.put(BLOB_KEY, data);
    await this.storage.put(BLOB_VERSION_KEY, current + 1);
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
    for (const key of stale.keys()) {
      await this.storage.delete(key);
    }
    for (const [scope, values] of counters) {
      await this.storage.put(COUNTER_PREFIX + scope, values);
    }
    const version = (await this.storage.get<number>(BLOB_VERSION_KEY)) ?? 0;
    if (blob === null) {
      await this.storage.delete(BLOB_KEY);
    } else {
      await this.storage.put(BLOB_KEY, blob);
    }
    await this.storage.put(BLOB_VERSION_KEY, version + 1);
  }
}

export type { AssignmentRecord, DerivedState };
