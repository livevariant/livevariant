#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { MemoryStore } from "./store/memory.js";
import { unlistedDestinationMode } from "./trust.js";

/**
 * Node entrypoint, for local development and small self-hosts. State is
 * in-process and lost on restart: the durable deployment is
 * @livevariant/workers (one Durable Object per test). Another backend only
 * has to implement the StateStore contract in ./store/types.ts.
 *
 * Env vars mirror the Workers deployment's (wrangler.jsonc), so moving
 * between the two changes nothing about configuration.
 */
const port = Number(process.env.PORT ?? 8787);

/** Comma-separated env var to list; blank means unset. */
function listVar(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(",")
    .map(h => h.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}

console.warn(
  "livevariant-server uses an in-memory store: state is lost on restart. " +
    "Deploy @livevariant/workers for durable state."
);

const app = createApp({
  store: new MemoryStore(),
  serveUrl: process.env.LV_SERVE_URL || undefined,
  apiToken: process.env.LV_API_TOKEN || undefined,
  gtmId: process.env.LV_GOOGLE_TAG_MANAGER || undefined,
  allowedDestinations: listVar(process.env.LV_ALLOWED_DESTINATIONS),
  allowedOrigins: listVar(process.env.LV_ALLOWED_ORIGINS),
  unlistedDestinations: unlistedDestinationMode(
    process.env.LV_UNLISTED_DESTINATIONS
  )
});

serve({ fetch: app.fetch, port }, info => {
  console.log(`livevariant-server listening on :${info.port}`);
});
