import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "@livevariant/sdk",
          include: ["src/**/*.browser.spec.ts"],
          // Real-browser tests: the SDK's whole job is cookie parsing,
          // storage, and dataLayer interception, so jsdom would prove
          // nothing.
          browser: {
            enabled: true,
            // Headed run: HEADED=1 npx nx test @livevariant/sdk
            headless: !process.env.HEADED,
            provider: playwright(),
            instances: [{ browser: "chromium" }]
          }
        }
      },
      {
        test: {
          // The headless entry path — no window at all — is exactly what
          // node scripts and agents hit, so it runs in plain node on
          // purpose: a browser (or jsdom) would mask the missing globals
          // these tests exist to exercise.
          name: "@livevariant/sdk:node",
          include: ["src/**/*.node.spec.ts"],
          environment: "node"
        }
      }
    ]
  }
});
