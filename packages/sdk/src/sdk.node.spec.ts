import { describe, expect, it } from "vitest";
import {
  computeTestId,
  parseTestConfig,
  type TestConfig,
  type TestConfigInput
} from "@livevariant/core";
import { createTest, type CreateTestOptions } from "./index.js";

/**
 * Headless tests, plain node on purpose: no window, no DOM globals, no
 * shim. This is the entry path node scripts and agents hit, so the
 * assertions are about what replaces the browser surface — process
 * identity, unscoped configs, fast failure — and about the wire shape
 * staying identical to what a page sends.
 */

function cfg(name: string): TestConfigInput {
  return {
    name: `headless ${name}`,
    variants: [
      { name: "control", text: "Buy now" },
      { name: "variant", text: "Get started" }
    ],
    statsKeyHash: "0".repeat(64)
  };
}

interface FakeServer {
  fetch: typeof fetch;
  chooseCalls: any[];
  rewardCalls: any[];
}

function fakeServer(cell = 1): FakeServer {
  const server: FakeServer = { chooseCalls: [], rewardCalls: [], fetch: null! };
  server.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/choose")) {
      server.chooseCalls.push(body);
      return Response.json({ cell, choice: [cell] });
    }
    if (url.endsWith("/reward")) {
      server.rewardCalls.push(body);
      return Response.json({ rewarded: true, first: true });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return server;
}

function options(
  server: FakeServer,
  extra?: Partial<CreateTestOptions>
): CreateTestOptions {
  return {
    serverUrl: "https://livevariant.link",
    fetch: server.fetch,
    ...extra
  };
}

describe("createTest headless", () => {
  it("serves with no window at all, on the browser wire shape", async () => {
    expect(typeof window).toBe("undefined");
    const server = fakeServer(1);
    const test = await createTest(cfg("no-window"), options(server));
    expect(test.fallback).toBe(false);
    expect(test.variant.text).toBe("Get started");
    expect(server.chooseCalls).toHaveLength(1);
    const call = server.chooseCalls[0];
    expect(call.testId).toBe(test.testId);
    expect(call.slotSizes).toEqual([2]);
    expect(typeof call.idHash).toBe("string");
    expect(call.idHash.length).toBeGreaterThan(0);
  });

  it("is one visitor per process: second call serves from cache", async () => {
    const server = fakeServer(0);
    const first = await createTest(cfg("process-identity"), options(server));
    const second = await createTest(cfg("process-identity"), options(server));
    expect(second.cell).toBe(first.cell);
    // The generated id persisted, so the cached assignment matched and
    // the server was only asked once.
    expect(server.chooseCalls).toHaveLength(1);
  });

  it("hashes an explicit externalId into a distinct identity", async () => {
    const server = fakeServer(0);
    const shared = cfg("explicit-id");
    await createTest(shared, options(server, { externalId: "alice" }));
    await createTest(shared, options(server, { externalId: "bob" }));
    // A different id cannot reuse alice's cached assignment.
    expect(server.chooseCalls).toHaveLength(2);
    expect(server.chooseCalls[0].idHash).not.toBe(server.chooseCalls[1].idHash);
  });

  it("keeps keyless configs unscoped: no hostname exists to scope to", async () => {
    const server = fakeServer(0);
    const keyless: TestConfigInput = {
      name: "headless keyless",
      variants: ["a", "b"]
    };
    const test = await createTest(keyless, options(server));
    expect(test.testId).toBe(
      await computeTestId(parseTestConfig(keyless) as TestConfig)
    );
  });

  it("fails fast without a serverUrl: no tag manager to wait for", async () => {
    const started = Date.now();
    await expect(createTest(cfg("no-server"))).rejects.toThrow(/serverUrl/);
    // Fail-fast, not the 3s tag wait a page would give the tag manager.
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("degrades to control when the server is unreachable", async () => {
    const test = await createTest(cfg("unreachable"), {
      serverUrl: "https://livevariant.invalid",
      fetch: (() => Promise.reject(new Error("down"))) as typeof fetch
    });
    expect(test.fallback).toBe(true);
    expect(test.variant.index).toBe(0);
    expect(test.variant.text).toBe("Buy now");
  });

  it("reports conversions through trackConversion", async () => {
    const server = fakeServer(1);
    const test = await createTest(cfg("conversion"), options(server));
    await test.trackConversion(2);
    expect(server.rewardCalls).toHaveLength(1);
    expect(server.rewardCalls[0]).toMatchObject({
      testId: test.testId,
      amount: 2
    });
  });
});
