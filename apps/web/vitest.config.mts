import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    name: "@livevariant/web",
    include: ["src/**/*.browser.spec.ts"],
    // tests-store is localStorage persistence: a real browser is the
    // only honest environment for it.
    browser: {
      enabled: true,
      headless: !process.env.HEADED,
      provider: playwright(),
      instances: [{ browser: "chromium" }]
    }
  }
});
