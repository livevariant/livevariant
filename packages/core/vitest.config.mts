import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/core",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
