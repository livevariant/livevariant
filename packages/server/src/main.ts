#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { MemoryStore } from "./store/memory.js";

/**
 * Node entrypoint, for local development and small self-hosts. State is
 * in-process and lost on restart: the durable deployment is
 * @livevariant/workers (one Durable Object per test). Another backend only
 * has to implement the StateStore contract in ./store/types.ts.
 */
const port = Number(process.env.PORT ?? 8787);

console.warn(
  "livevariant-server uses an in-memory store: state is lost on restart. " +
    "Deploy @livevariant/workers for durable state."
);

serve({ fetch: createApp({ store: new MemoryStore() }).fetch, port }, info => {
  console.log(`livevariant-server listening on :${info.port}`);
});
