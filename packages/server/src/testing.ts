/**
 * Test-only entry point: `@livevariant/server/testing`.
 *
 * Separate from the package root because it imports vitest, which is a
 * peer dependency only someone running tests will have. Import this from
 * a vitest suite, never from application code.
 */
export { storeContract } from "./store/contract.js";
