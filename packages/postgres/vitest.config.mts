import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/postgres",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // PGlite boots a WASM Postgres per suite; the contract's concurrency
    // cases then run 50 statements at a time against it.
    testTimeout: 60000
  }
});
