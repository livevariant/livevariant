#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { MemoryStore } from "./store/memory.js";
import { RedisStore } from "./store/redis.js";

/**
 * Self-host entrypoint: `livevariant-server` with REDIS_URL (recommended)
 * or an in-process memory store (single node, state lost on restart).
 */
const port = Number(process.env.PORT ?? 8787);
const redisUrl = process.env.REDIS_URL;

const store = redisUrl ? await RedisStore.connect(redisUrl) : new MemoryStore();
if (!redisUrl) {
  console.warn(
    "REDIS_URL not set: using in-memory store (state is lost on restart)"
  );
}

serve({ fetch: createApp({ store }).fetch, port }, info => {
  console.log(`livevariant-server listening on :${info.port}`);
});
