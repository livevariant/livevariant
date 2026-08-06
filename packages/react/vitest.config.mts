import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "@livevariant/react",
    include: ["src/**/*.browser.spec.tsx"],
    // Form components in a real browser: focus, file inputs and
    // clipboard are exactly what jsdom fakes badly.
    browser: {
      enabled: true,
      headless: !process.env.HEADED,
      provider: playwright(),
      instances: [{ browser: "chromium" }]
    }
  }
});
