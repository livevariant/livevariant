import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/server",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
