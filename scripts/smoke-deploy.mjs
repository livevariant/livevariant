#!/usr/bin/env node
/**
 * Post-deploy check. `wrangler deploy` succeeding only means the upload
 * was accepted: routes take a moment to propagate, and a bundle that
 * imports something the runtime does not have fails on the first real
 * request rather than at build time.
 *
 * So this asks the live deployment to actually do the three things that
 * would break independently: serve, describe itself, and speak MCP.
 */
const origin = (process.argv[2] ?? "https://livevariant.com").replace(
  /\/+$/,
  ""
);
const DEADLINE_MS = 90_000;

async function until(label, check) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const detail = await check();
      console.log(`  ok   ${label}${detail ? ` (${detail})` : ""}`);
      return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error(`${label}: ${last}`);
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

console.log(`smoke test ${origin}`);

await until("health", async () => {
  const res = await fetch(`${origin}/health`);
  const body = await res.json();
  expect(res.ok && body.ok === true, `status ${res.status}`);
});

await until("openapi document", async () => {
  const res = await fetch(`${origin}/openapi.json`);
  expect(res.ok, `status ${res.status}`);
  const doc = await res.json();
  const paths = Object.keys(doc.paths ?? {});
  expect(paths.length > 0, "document lists no paths");
  return `${paths.length} operations`;
});

// The end-to-end one: build a test through the API, serve it, and read the
// result back. It exercises the Durable Object, the redirect path and the
// tools' in-process fetch, which is the piece that broke in production
// when it tried to reach its own hostname.
await until("build, serve and read a test", async () => {
  const built = await (
    await fetch(`${origin}/api/v1/build-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ci smoke",
        variants: [
          { url: "https://example.com/a" },
          { url: "https://example.com/b" }
        ]
      })
    })
  ).json();
  expect(built.config, `build failed: ${JSON.stringify(built).slice(0, 200)}`);

  const serve = await fetch(`${built.urls.serve}?id=ci-${Date.now()}`, {
    redirect: "manual",
    headers: { accept: "text/html" }
  });
  expect(serve.status === 302, `serve returned ${serve.status}`);

  const stats = await (
    await fetch(`${origin}/api/v1/get-stats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        test: built.config,
        statsSecret: built.statsSecret
      })
    })
  ).json();
  expect(
    stats.totalAssignments === 1,
    `stats returned ${JSON.stringify(stats).slice(0, 200)}`
  );
  return "302 served, 1 assignment recorded";
});

await until("mcp endpoint", async () => {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" }
      }
    })
  });
  expect(res.ok, `status ${res.status}`);
  const body = await res.json();
  expect(body.result?.serverInfo?.name, "no serverInfo in initialize result");
  return body.result.serverInfo.name;
});

console.log("deployment is answering");
