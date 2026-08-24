#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, DEFAULT_SERVER_URL } from "./index.js";

/**
 * stdio entry point. Nothing may be written to stdout except protocol
 * frames, so every diagnostic goes to stderr.
 *
 * LIVEVARIANT_SERVER_URL points the tools at a self-hosted deployment.
 * LIVEVARIANT_API_TOKEN carries the deployment's LV_API_TOKEN when the
 * operator has gated their API with one: it rides as a Bearer header on
 * every call this server makes to that one origin, and nowhere else.
 * LIVEVARIANT_ASSET_UPLOAD_TOKEN carries LV_ASSET_UPLOAD_TOKEN for
 * deployments that gate /assets separately.
 */
const serverUrl = process.env.LIVEVARIANT_SERVER_URL ?? DEFAULT_SERVER_URL;
const apiToken = process.env.LIVEVARIANT_API_TOKEN;
const assetUploadToken =
  process.env.LIVEVARIANT_ASSET_UPLOAD_TOKEN ??
  process.env.LV_ASSET_UPLOAD_TOKEN;

const fetchImpl: typeof globalThis.fetch = apiToken
  ? (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        serverUrl
      );
      // The token authenticates us to OUR deployment only; a tool
      // fetching anywhere else (an asset host, DoH) must never leak it.
      if (url.origin !== new URL(serverUrl).origin) {
        return globalThis.fetch(input, init);
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      if (!headers.has("authorization")) {
        headers.set("authorization", `Bearer ${apiToken}`);
      }
      return globalThis.fetch(input, { ...init, headers });
    }
  : globalThis.fetch;

async function main(): Promise<void> {
  const server = createServer({
    serverUrl,
    assetUploadToken,
    fetch: fetchImpl
  });
  await server.connect(new StdioServerTransport());
  console.error(`livevariant mcp ready (serving ${serverUrl})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
