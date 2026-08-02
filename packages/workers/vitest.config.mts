import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@livevariant/workers",
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
