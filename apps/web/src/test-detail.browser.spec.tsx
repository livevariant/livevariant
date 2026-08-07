import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { configFromParams, encodeConfig } from "@livevariant/core";
import { TestDetail } from "./pages/TestDetail";
import { resetDeploymentConfig } from "./lib/serve-url";

/**
 * The ESP template card is the dashboard's half of the template flow:
 * whatever the visitor built, the card must hand back links derived
 * from the REAL config (slots, names, dims, kh), all sharing one
 * identity. The server half of the same flow is proven end to end in
 * packages/server/src/api.spec.ts; this spec pins the links a browser
 * user copies.
 */

let roots: Root[] = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
  localStorage.clear();
  resetDeploymentConfig();
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
        serveUrl: "https://livevariant.link",
        region: null,
        gtmId: null,
        publishableKey: null
      });
    }
    return new Response("404", { status: 404 });
  });
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

function render(encoded: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const router = createMemoryRouter(
    [{ path: "/manage/:encoded", element: <TestDetail /> }],
    { initialEntries: [`/manage/${encoded}`] }
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

const field = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

describe("the ESP template card", () => {
  it("derives identity-consistent links from the real config", async () => {
    const { encoded } = await encodeConfig({
      v: 2,
      name: "Daily brew",
      slots: {
        hero: [
          { url: "https://cdn.example.com/warm.jpg", name: "warm" },
          { url: "https://cdn.example.com/cool.jpg", name: "cool" }
        ],
        cta: [
          { url: "https://cdn.example.com/go.jpg", name: "go" },
          { url: "https://cdn.example.com/wait.jpg", name: "wait" }
        ]
      },
      ctx: { dims: [{ key: "source", from: "utm_source" }] },
      statsKeyHash: "a".repeat(64)
    });
    const container = render(encoded);
    await until(() => field(container, "Link href (click)") != null);

    const hero = field(container, "Image src (hero)")!.value;
    const cta = field(container, "Image src (cta)")!.value;
    const click = field(container, "Link href (click)")!.value;

    // The card renders the whole test, not a two-variant skeleton.
    expect(hero).toContain("s=hero");
    expect(hero).toContain("vn=warm");
    expect(hero).toContain(encodeURIComponent("source:utm_source"));
    expect(hero).toContain(`kh=${"a".repeat(64)}`);
    expect(hero).toContain("&slot=hero");
    expect(cta).toContain("&slot=cta");
    // One slot-less click; the landing page is a merge field on EVERY
    // link, because r is part of the test's identity.
    expect(click).not.toContain("slot=");
    for (const link of [hero, cta, click]) {
      expect(link).toContain("r={{landing_url}}");
      expect(link).toContain("id={{recipient_id}}");
    }

    // Filled in, all three links spell ONE test.
    const fill = (link: string) =>
      link.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, key: string) =>
        encodeURIComponent(
          key === "recipient_id" ? "reader-1" : `https://filled.example/${key}`
        )
      );
    const ids = await Promise.all(
      [hero, cta, click].map(async link => {
        const { testId } = await configFromParams(
          new URL(fill(link)).searchParams
        );
        return testId;
      })
    );
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
  });
});
