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
    // Pinned: the dev worker's LV_APP_URL (wrangler.jsonc env.dev) names
    // this origin for cookies and the auth host gate. strictPort makes a
    // taken port fail loudly instead of silently sliding to 5174 and
    // hiding every account control.
    port: 5173,
    strictPort: true,
    // Dev-only: /config answered by a locally running LiveVariant server
    // (npx tsx packages/server/src/main.ts) makes the page's own
    // dogfooding test live in development; without one, /config 404s and
    // the SDK falls back to control, which is the documented behaviour.
    proxy: {
      "/config": "http://localhost:8787",
      "/choose": "http://localhost:8787",
      "/reward": "http://localhost:8787",
      "/stats": "http://localhost:8787",
      // changeOrigin must stay OFF for the account prefixes: the worker
      // host-gates them to LV_APP_URL (this vite origin), and the
      // shorthand form rewrites Host to localhost:8787, which reads as
      // "the serving domain" and correctly answers 404.
      "/account": { target: "http://localhost:8787", changeOrigin: false },
      "/auth": { target: "http://localhost:8787", changeOrigin: false }
    }
  }
});
