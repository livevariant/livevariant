import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppLayout } from "./App";
import { Builder } from "./pages/Builder";
import { TestDetail } from "./pages/TestDetail";
import { loadTests } from "./lib/tests-store";
import { resetAccount } from "./lib/account";
import { resetDeploymentConfig } from "./lib/serve-url";

/**
 * The create flow inside the real dashboard, one E2E per test type:
 * pick (or arrive at) a type, fill its form, and end with a persisted
 * record of that type and the detail page open. The deep per-form
 * behavior is pinned in @livevariant/react's own specs; these pin the
 * page wiring: deployment defaults in, persistence and navigation out.
 */

let roots: Root[] = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
  localStorage.clear();
  resetDeploymentConfig();
  resetAccount();
  stubServer();
});

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
});

function stubServer() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = new URL(url, window.location.origin).pathname;
    if (path === "/config") {
      return Response.json({
        serveUrl: "https://serve.example",
        region: "weur",
        gtmId: null,
        publishableKey: null
      });
    }
    if (path === "/account/me") {
      return Response.json({ error: "sign in required" }, { status: 401 });
    }
    if (path.startsWith("/stats/")) {
      return Response.json({
        totalAssignments: 0,
        combinations: [],
        slots: {},
        buckets: {}
      });
    }
    return new Response("404", { status: 404 });
  });
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
          { path: "/builder", element: <Builder /> },
          { path: "/tests/:testId", element: <TestDetail /> }
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

async function until(check: () => boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition never became true");
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function setByLabel(container: HTMLElement, label: string, value: string) {
  const input = container.querySelector(
    `[aria-label="${label}"]`
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(b =>
    b.textContent?.includes(text)
  );
  expect(button, `button containing ${text}`).not.toBeUndefined();
  button!.click();
}

describe("creating each test type from the dashboard", () => {
  it("redirect: picker to saved record to detail page", async () => {
    const container = render("/builder");
    await until(
      () => container.textContent?.includes("Page redirect test") ?? false
    );
    click(container, "Page redirect test");
    await until(
      () => container.textContent?.includes("Destination pages") ?? false
    );
    setByLabel(container, "Variant 1 destination URL", "https://example.com/a");
    setByLabel(container, "Variant 2 destination URL", "https://example.com/b");
    click(container, "Create redirect test");
    await until(() => loadTests().length > 0);
    expect(loadTests()[0].type).toBe("redirect");
    // The deployment default flowed into the link.
    await until(
      () => container.textContent?.includes("https://serve.example/s/") ?? false
    );
    click(container, "View results");
    await until(() => container.textContent?.includes(loadTests()[0].name));
  });

  it("email: arrives typed via ?type=, saves an email record", async () => {
    const container = render("/builder?type=email");
    await until(
      () => container.textContent?.includes("Image variants") ?? false
    );
    setByLabel(
      container,
      "Element 1 variant 1 image URL",
      "https://cdn.example/a.png"
    );
    setByLabel(
      container,
      "Element 1 variant 2 image URL",
      "https://cdn.example/b.png"
    );
    click(container, "Create email test");
    await until(() => loadTests().length > 0);
    expect(loadTests()[0].type).toBe("email");
    await until(
      () => container.textContent?.includes("Put it in your email") ?? false
    );
  });

  it("website: saves a website record and shows the tag snippet", async () => {
    const container = render("/builder?type=website");
    await until(() => container.textContent?.includes("Variants") ?? false);
    setByLabel(container, "Element 1 variant 1 text", "Ship faster");
    setByLabel(container, "Element 1 variant 2 text", "Ship safer");
    click(container, "Create website test");
    await until(() => loadTests().length > 0);
    expect(loadTests()[0].type).toBe("website");
    await until(
      () =>
        container.textContent?.includes("https://serve.example/sdk.js") ?? false
    );
  });
});

describe("the LLM card's prefilled prompt", () => {
  it("carries the signed-in user's publishable key, copy-ready", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, window.location.origin).pathname;
      if (path === "/config") {
        return Response.json({
          serveUrl: "https://serve.example",
          region: null,
          gtmId: null,
          publishableKey: null
        });
      }
      if (path === "/account/me") {
        return Response.json({
          userId: "u1",
          activeOrgId: "org-1",
          orgs: [{ id: "org-1", name: "Personal" }]
        });
      }
      if (path === "/account/publishable-keys") {
        return Response.json({
          keys: [{ key: "pk_promptkey1234567890abcd", label: null }]
        });
      }
      return new Response("404", { status: 404 });
    });
    const container = render("/builder");
    await until(
      () => container.textContent?.includes("heavy lifting") ?? false
    );
    click(container, "Use your LLM to do the heavy lifting");
    await until(
      () =>
        container.textContent?.includes("pk_promptkey1234567890abcd") ?? false
    );
    // The whole prompt is one copyable block containing the key.
    const block = [...container.querySelectorAll("pre")].find(pre =>
      pre.textContent?.includes("pk_promptkey1234567890abcd")
    );
    expect(block).not.toBeUndefined();
    expect(block!.textContent).toContain("Register the test");
  });

  it("points key-less users at Settings instead", async () => {
    const container = render("/builder");
    await until(
      () => container.textContent?.includes("heavy lifting") ?? false
    );
    click(container, "Use your LLM to do the heavy lifting");
    await until(
      () => container.textContent?.includes("create a publishable key") ?? false
    );
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
  });
});
