import type { ModelBlob } from "./snapshot.js";

/**
 * Memory cache of decoded model blobs, keyed by (testId, blob version).
 *
 * Where it earns its keep: inside a Durable Object. The instance is
 * long-lived and single-threaded, and every request for a test lands on
 * it, so decoding the same blob on every serve is pure waste; the
 * version number makes invalidation exact. The Node server holds one
 * TestService for its lifetime and benefits the same way.
 *
 * Entries are copied on the way in AND out. Callers mutate the model
 * (observe/reward before a CAS write), and a failed CAS must not leave
 * the cache holding a mutated model under the old version.
 */
export class ModelCache {
  private entries = new Map<string, { version: number; blob: ModelBlob }>();

  constructor(private maxEntries = 64) {}

  get(testId: string, version: number): ModelBlob | null {
    const entry = this.entries.get(testId);
    if (!entry || entry.version !== version) {
      return null;
    }
    // Refresh recency (Map iteration order is insertion order).
    this.entries.delete(testId);
    this.entries.set(testId, entry);
    return copyBlob(entry.blob);
  }

  set(testId: string, version: number, blob: ModelBlob): void {
    this.entries.delete(testId);
    this.entries.set(testId, { version, blob: copyBlob(blob) });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

function copyBlob(blob: ModelBlob): ModelBlob {
  return {
    slotSizes: [...blob.slotSizes],
    dim: blob.dim,
    model: {
      aInv: blob.model.aInv.map(row => row.slice()),
      b: blob.model.b.slice()
    }
  };
}
