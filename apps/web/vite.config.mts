import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    // Dev-only: /config answered by a locally running LiveVariant server
    // (npx tsx packages/server/src/main.ts) makes the page's own
    // dogfooding test live in development; without one, /config 404s and
    // the SDK falls back to control, which is the documented behaviour.
    proxy: {
      "/config": "http://localhost:8787",
      "/choose": "http://localhost:8787",
      "/reward": "http://localhost:8787",
      "/stats": "http://localhost:8787",
      "/account": "http://localhost:8787",
      "/auth": "http://localhost:8787"
    }
  }
});
