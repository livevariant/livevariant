import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { hashStatsSecret } from "@livevariant/core";
import { Settings } from "./pages/Settings";
import { resetAccount } from "./lib/account";

/**
 * The stats keys card, driven like a user would: the list renders what
 * /account/keys answers, "Generate key" mints a secret CLIENT-side,
 * claims its hash, and shows the secret exactly once alongside the kh
 * the template needs. The claim body must carry the secret (the server
 * hashes it); the kh shown must be that hash and nothing else.
 */

let roots: Root[] = [];
let containers: HTMLElement[] = [];
let claims: Array<{ statsSecret: string; label?: string }> = [];
let listed: Array<Record<string, unknown>> = [];

beforeEach(() => {
  localStorage.clear();
  resetAccount();
  claims = [];
  // The server lists named keys only (filtered in SQL); the card
  // renders exactly what it is given.
  listed = [
    {
      kh: "c".repeat(64),
      label: "newsletter",
      lockReads: false,
      claimedAt: Date.now(),
      testCount: 3
    }
  ];
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
      if (path === "/account/me") {
        return Response.json({
          userId: "u1",
          activeOrgId: "org1",
          orgs: [{ id: "org1", name: "Test Org", role: "owner" }]
        });
      }
      if (path === "/account/keys" && (init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          statsSecret: string;
          label?: string;
        };
        claims.push(body);
        const kh = await hashStatsSecret(body.statsSecret);
        listed = [
          ...listed,
          {
            kh,
            label: body.label ?? null,
            lockReads: false,
            claimedAt: Date.now(),
            testCount: 0
          }
        ];
        return Response.json({ kh, orgId: "org1" }, { status: 201 });
      }
      if (path === "/account/keys") {
        return Response.json({ keys: listed });
      }
      if (path === "/account/domains") {
        return Response.json({ domains: [] });
      }
      if (path === "/account/publishable-keys") {
        return Response.json({ keys: [] });
      }
      return new Response("404", { status: 404 });
    }
  );
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
  const router = createMemoryRouter(
    [{ path: "/settings", element: <Settings /> }],
    { initialEntries: ["/settings"] }
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

const buttonByText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(b =>
    b.textContent?.includes(text)
  );

function typeInto(
  container: HTMLElement,
  ariaLabel: string,
  value: string
): void {
  const input = container.querySelector<HTMLInputElement>(
    `input[aria-label="${ariaLabel}"]`
  )!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the stats keys card", () => {
  it("lists the named keys with their kh, count and label", async () => {
    const container = render();
    await until(() => container.textContent?.includes("Stats keys") ?? false);
    await until(() => container.textContent?.includes("c".repeat(64)) ?? false);
    expect(container.textContent).toContain("newsletter");
    expect(container.textContent).toContain("3 tests");
  });

  it("generates a key client-side and shows the secret exactly once", async () => {
    const container = render();
    await until(() => buttonByText(container, "Generate key") != null);
    // Naming is required: it is what marks the key as deliberate.
    expect(buttonByText(container, "Generate key")!.disabled).toBe(true);
    typeInto(container, "Key label", "august-campaigns");
    await until(() => !buttonByText(container, "Generate key")!.disabled);
    buttonByText(container, "Generate key")!.click();
    await until(
      () => container.textContent?.includes("shown exactly once") ?? false
    );
    // The claim sent a client-minted secret, never empty, never a hash.
    expect(claims).toHaveLength(1);
    expect(claims[0].statsSecret.length).toBeGreaterThanOrEqual(8);
    // The kh presented back is exactly the hash of that secret: the
    // value the user wires into their template.
    const kh = await hashStatsSecret(claims[0].statsSecret);
    expect(container.textContent).toContain(claims[0].statsSecret);
    expect(container.textContent).toContain(kh);
  });

  it("claims an existing secret pasted by hand, named", async () => {
    const container = render();
    await until(() => buttonByText(container, "Claim") != null);
    typeInto(container, "Stats secret", "my-own-espresso-secret");
    // A secret alone is not enough: the name is what promotes the key
    // into this list.
    expect(buttonByText(container, "Claim")!.disabled).toBe(true);
    typeInto(container, "Key label", "espresso");
    await until(() => !buttonByText(container, "Claim")!.disabled);
    buttonByText(container, "Claim")!.click();
    await until(() => claims.length === 1);
    expect(claims[0].statsSecret).toBe("my-own-espresso-secret");
    expect(claims[0].label).toBe("espresso");
    // The list refreshes with the new key's hash.
    const kh = await hashStatsSecret("my-own-espresso-secret");
    await until(() => container.textContent?.includes(kh) ?? false);
  });
});
