import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/accounts",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
