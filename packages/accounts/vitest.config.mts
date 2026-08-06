import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/accounts",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // The end-to-end specs drive Better Auth against a real local D1
    // through getPlatformProxy: dozens of sequential requests each.
    // The default 5s holds on a warm laptop and flakes on CI runners.
    testTimeout: 30_000
  }
});
