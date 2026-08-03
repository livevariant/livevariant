import { MemoryStore } from "./memory.js";
import { storeContract } from "./contract.js";

/**
 * MemoryStore is the reference implementation, so it runs the same
 * conformance suite adapter authors import from
 * `@livevariant/server/testing`. One store instance across all cases on
 * purpose: adapters with persistent backends cannot hand out a fresh
 * universe per test, so the suite must isolate by testId, and running the
 * reference the same way keeps the suite honest about that.
 */
const memory = new MemoryStore();
storeContract("MemoryStore", () => memory);
