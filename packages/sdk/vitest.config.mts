import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    name: "@livevariant/sdk",
    include: ["src/**/*.browser.spec.ts"],
    // Real-browser tests: the SDK's whole job is cookie parsing, storage,
    // and dataLayer interception, so jsdom would prove nothing.
    browser: {
      enabled: true,
      // Headed run: HEADED=1 npx nx test @livevariant/sdk
      headless: !process.env.HEADED,
      provider: playwright(),
      instances: [{ browser: "chromium" }]
    }
  }
});
