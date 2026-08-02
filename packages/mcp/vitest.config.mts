import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/mcp",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
