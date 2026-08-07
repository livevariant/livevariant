import { describe, expect, it, vi } from "vitest";

/**
 * The entry files are two lines of glue, and one of those lines broke
 * in production: `app.fetch(request)` without the ExecutionContext
 * makes Hono's c.executionCtx throw, waitUntil never engages, and SDK
 * first-sight registration died at its first await once the response
 * was sent. Every unit test passed, because they all drive the Hono
 * app directly with a proper context. This spec pins the glue itself:
 * whatever the runtime hands the entry must reach the app verbatim.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {}
}));

const appFetch = vi.fn(async () => new Response("ok"));
vi.mock("@livevariant/server", async importOriginal => {
  const real = await importOriginal<typeof import("@livevariant/server")>();
  return { ...real, createApp: vi.fn(() => ({ fetch: appFetch })) };
});

import baseEntry from "./index.js";
import hostedEntry from "./index.hosted.js";

function stubCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {}
  } as unknown as ExecutionContext;
}

describe("worker entries", () => {
  it("the base entry forwards request, env and ctx to the app", async () => {
    const request = new Request("http://example.com/health");
    const env = {} as never;
    const ctx = stubCtx();
    await baseEntry.fetch(request, env, ctx);
    expect(appFetch).toHaveBeenLastCalledWith(request, env, ctx);
  });

  it("the hosted entry forwards request, env and ctx to the app", async () => {
    const request = new Request("http://example.com/health");
    const env = {} as never;
    const ctx = stubCtx();
    await hostedEntry.fetch(request, env, ctx);
    expect(appFetch).toHaveBeenLastCalledWith(request, env, ctx);
  });
});
