#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, DEFAULT_SERVER_URL } from "./index.js";

/**
 * stdio entry point. Nothing may be written to stdout except protocol
 * frames, so every diagnostic goes to stderr.
 *
 * LIVEVARIANT_SERVER_URL points the tools at a self-hosted deployment.
 */
const serverUrl = process.env.LIVEVARIANT_SERVER_URL ?? DEFAULT_SERVER_URL;

async function main(): Promise<void> {
  const server = createServer({ serverUrl });
  await server.connect(new StdioServerTransport());
  console.error(`livevariant mcp ready (serving ${serverUrl})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
