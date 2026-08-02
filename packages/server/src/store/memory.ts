import type { AssignmentRecord, DerivedState } from "@livevariant/core";
import {
  counterKey,
  linearKey,
  type StateStore,
  type TestPolicy,
  type TestShape
} from "./types.js";
import { derivedToArtifacts } from "./snapshot.js";
import { mergePolicy } from "./types.js";

/** In-process store for tests and single-node development. */
export class MemoryStore implements StateStore {
  private assignments = new Map<string, Map<string, AssignmentRecord>>();
  private counters = new Map<string, number[]>();
  private blobs = new Map<string, { data: string; version: number }>();
  private shapes = new Map<string, TestShape>();

  private policies = new Map<string, TestPolicy>();

  async pinShape(
    testId: string,
    shape: TestShape,
    authoritative: boolean
  ): Promise<TestShape> {
    const existing = this.shapes.get(testId);
    if (existing && !authoritative) {
      return existing;
    }
    this.shapes.set(testId, { ...shape });
    return shape;
  }

  async getPolicy(testId: string): Promise<TestPolicy> {
    return this.policies.get(testId) ?? {};
  }

  async updatePolicy(testId: string, patch: TestPolicy): Promise<TestPolicy> {
    const merged = mergePolicy(this.policies.get(testId) ?? {}, patch);
    this.policies.set(testId, merged);
    return merged;
  }

  async getAssignment(
    testId: string,
    idHash: string
  ): Promise<AssignmentRecord | null> {
    return this.assignments.get(testId)?.get(idHash) ?? null;
  }

  async putAssignmentIfAbsent(
    testId: string,
    idHash: string,
    rec: AssignmentRecord
  ): Promise<{ rec: AssignmentRecord; created: boolean }> {
    let byId = this.assignments.get(testId);
    if (!byId) {
      byId = new Map();
      this.assignments.set(testId, byId);
    }
    const existing = byId.get(idHash);
    if (existing) {
      return { rec: existing, created: false };
    }
    const stored = { ...rec, featIdx: rec.featIdx ? [...rec.featIdx] : null };
    byId.set(idHash, stored);
    return { rec: stored, created: true };
  }

  async addReward(
    testId: string,
    idHash: string,
    amount: number
  ): Promise<{ rec: AssignmentRecord; first: boolean } | null> {
    const rec = this.assignments.get(testId)?.get(idHash);
    if (!rec) {
      return null;
    }
    const first = rec.rewardTotal === 0;
    rec.rewardTotal += amount;
    return { rec, first };
  }

  async *scanAssignments(testId: string): AsyncIterable<AssignmentRecord> {
    for (const rec of this.assignments.get(testId)?.values() ?? []) {
      yield rec;
    }
  }

  async incrCounters(key: string, deltas: number[]): Promise<void> {
    const current = this.counters.get(key) ?? [];
    for (let i = 0; i < deltas.length; i++) {
      current[i] = (current[i] ?? 0) + deltas[i];
    }
    this.counters.set(key, current);
  }

  async getCounters(key: string, length: number): Promise<number[]> {
    const current = this.counters.get(key) ?? [];
    return Array.from({ length }, (_, i) => current[i] ?? 0);
  }

  async getBlob(
    key: string
  ): Promise<{ data: string; version: number } | null> {
    return this.blobs.get(key) ?? null;
  }

  async putBlob(
    key: string,
    data: string,
    expectedVersion: number
  ): Promise<boolean> {
    const current = this.blobs.get(key);
    if ((current?.version ?? 0) !== expectedVersion) {
      return false;
    }
    this.blobs.set(key, { data, version: expectedVersion + 1 });
    return true;
  }

  async replaceDerived(testId: string, state: DerivedState): Promise<void> {
    for (const key of [...this.counters.keys()]) {
      if (key.startsWith(counterKey(testId, ""))) {
        this.counters.delete(key);
      }
    }
    const { counters, blob } = derivedToArtifacts(testId, state);
    for (const [key, values] of counters) {
      this.counters.set(key, values);
    }
    const existing = this.blobs.get(linearKey(testId));
    if (blob) {
      this.blobs.set(linearKey(testId), {
        data: blob,
        version: (existing?.version ?? 0) + 1
      });
    } else {
      this.blobs.delete(linearKey(testId));
    }
  }
}
