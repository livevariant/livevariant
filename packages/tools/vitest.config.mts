import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/tools",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
