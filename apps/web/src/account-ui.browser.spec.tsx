import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  encodeConfig,
  generateStatsSecret,
  hashStatsSecret
} from "@livevariant/core";
import { AppLayout } from "./App";
import { TestDetail } from "./pages/TestDetail";
import { saveTest } from "./lib/tests-store";

/**
 * The account UI in a real browser: these flows silently hid themselves
 * once when the deployment plumbing was miswired, so what renders (and
 * when it deliberately does not) is pinned here, not just the HTTP
 * layer underneath it.
 */

let roots: Root[] = [];
let containers: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) {
    root.unmount();
  }
  for (const container of containers) {
    container.remove();
  }
  roots = [];
  containers = [];
  vi.unstubAllGlobals();
  window.location.hash = "";
});

beforeEach(() => {
  localStorage.clear();
});

const STATS_OK = () =>
  Response.json({
    totalAssignments: 0,
    combinations: [],
    slots: {},
    buckets: {}
  });

/** Stubs fetch by path prefix; unmatched paths 404 like a bare server. */
function stubServer(
  handlers: Record<string, (init?: RequestInit) => Response>,
  calls?: string[]
) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, window.location.origin).pathname;
      calls?.push(`${init?.method ?? "GET"} ${path}`);
      for (const [prefix, handler] of Object.entries(handlers)) {
        if (path.startsWith(prefix)) {
          return handler(init);
        }
      }
      return new Response("404 Not Found", { status: 404 });
    }
  );
}

function render(path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const router = createMemoryRouter(
    [
      {
        element: <AppLayout />,
        children: [
          { path: "/", element: <div /> },
          { path: "/tests", element: <div /> },
          { path: "/tests/:testId", element: <TestDetail /> },
          { path: "/manage/:encoded", element: <TestDetail /> },
          { path: "/login", element: <div>login page</div> }
        ]
      }
    ],
    { initialEntries: [path] }
  );
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );
  return container;
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition never became true");
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function makeSavedTest() {
  const statsSecret = generateStatsSecret();
  const { encoded, testId } = await encodeConfig({
    v: 2,
    name: "ui flow test",
    variants: [
      { name: "a", url: "https://example.com/a" },
      { name: "b", url: "https://example.com/b" }
    ],
    statsKeyHash: await hashStatsSecret(statsSecret)
  } as never);
  return { encoded, testId, statsSecret };
}

describe("the header sign-in control", () => {
  it("appears when the deployment has accounts and nobody is signed in", async () => {
    stubServer({
      "/account/me": () =>
        Response.json({ error: "sign in required" }, { status: 401 })
    });
    const container = render("/");
    await until(() => container.textContent?.includes("Sign in") ?? false);
  });

  it("stays hidden on a deployment without accounts", async () => {
    stubServer({}); // every /account path answers 404
    const container = render("/");
    // Give the /account/me probe time to resolve, then assert absence.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(container.textContent).not.toContain("Sign in");
  });
});

describe("claiming from the test page", () => {
  it("offers 'log in to save' right after creating a test, signed out", async () => {
    const { encoded, testId, statsSecret } = await makeSavedTest();
    saveTest({
      name: "ui flow test",
      encoded,
      testId,
      statsSecret,
      serverUrl: window.location.origin,
      createdAt: Date.now()
    });
    stubServer({
      "/account/me": () =>
        Response.json({ error: "sign in required" }, { status: 401 }),
      "/stats/": STATS_OK
    });
    const container = render(`/tests/${testId}`);
    await until(
      () =>
        container.textContent?.includes(
          "Log in or create an account to save your tests"
        ) ?? false
    );
    const link = container.querySelector('a[href^="/login?next="]');
    expect(link).not.toBeNull();
  });

  it("auto-claims a manage link opened while signed in", async () => {
    const { encoded, statsSecret } = await makeSavedTest();
    window.location.hash = `#${statsSecret}`;
    const calls: string[] = [];
    stubServer(
      {
        "/account/me": () =>
          Response.json({ userId: "u1", activeOrgId: "org-1", orgs: [] }),
        "/account/keys": () =>
          Response.json({ kh: "k".repeat(64) }, { status: 201 }),
        "/account/tests": () => Response.json({ testId: "t" }, { status: 201 }),
        "/stats/": STATS_OK
      },
      calls
    );
    const container = render(`/manage/${encoded}`);
    await until(
      () => container.textContent?.includes("Saved to your account") ?? false
    );
    expect(calls).toContain("POST /account/keys");
    expect(calls).toContain("POST /account/tests");
  });

  it("shows the explicit button, not auto-claim, on a saved test", async () => {
    const { encoded, testId, statsSecret } = await makeSavedTest();
    saveTest({
      name: "ui flow test",
      encoded,
      testId,
      statsSecret,
      serverUrl: window.location.origin,
      createdAt: Date.now()
    });
    const calls: string[] = [];
    stubServer(
      {
        "/account/me": () =>
          Response.json({ userId: "u1", activeOrgId: "org-1", orgs: [] }),
        "/stats/": STATS_OK
      },
      calls
    );
    const container = render(`/tests/${testId}`);
    await until(
      () => container.textContent?.includes("Add to my account") ?? false
    );
    expect(calls.filter(c => c.startsWith("POST /account"))).toEqual([]);
  });
});
