import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Landing } from "./pages/Landing";

/**
 * The hero headline is served by a real test, which means it is not
 * knowable at first paint. What the visitor must never see is the
 * control flipping to the chosen variant, so the hero hides itself
 * until the decision (or the fallback) is in. And the deployment's own
 * publishable key must ride along on /choose: it is what makes the
 * landing's test appear in OUR dashboard.
 */

let roots: Root[] = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
  localStorage.clear();
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

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const router = createMemoryRouter([{ path: "/", element: <Landing /> }], {
    initialEntries: ["/"]
  });
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

const hero = (container: HTMLElement) =>
  container.querySelector("h1")?.parentElement as HTMLElement;

describe("the landing hero test", () => {
  it("hides the headline until the decision is in, and registers under the deployment's key", async () => {
    let releaseConfig!: () => void;
    const configGate = new Promise<void>(resolve => {
      releaseConfig = resolve;
    });
    const chooseBodies: string[] = [];
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
        if (path === "/config") {
          await configGate;
          return Response.json({
            serveUrl: window.location.origin,
            region: null,
            gtmId: null,
            publishableKey: "pk_own"
          });
        }
        if (path === "/choose") {
          chooseBodies.push(String(init?.body ?? ""));
          // No serving backend in this test: the SDK degrades to the
          // control combination, which still counts as a decision.
          return new Response("nope", { status: 404 });
        }
        return new Response("404", { status: 404 });
      }
    );
    const container = render();
    await until(() => hero(container) != null);
    // Undecided: present in the layout but invisible.
    expect(hero(container).className).toContain("opacity-0");
    releaseConfig();
    await until(() => hero(container).className.includes("opacity-100"));
    expect(container.querySelector("h1")?.textContent).toBeTruthy();
    // The /config key went along on the assignment request.
    expect(chooseBodies.length).toBeGreaterThan(0);
    expect(chooseBodies[0]).toContain("pk_own");
  });
});
