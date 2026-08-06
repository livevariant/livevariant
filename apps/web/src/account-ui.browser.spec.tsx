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
import { AcceptInvitation } from "./pages/AcceptInvitation";
import { OrgSwitcher } from "./components/OrgSwitcher";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";
import { TestDetail } from "./pages/TestDetail";
import { Terms } from "./pages/Terms";
import { Privacy } from "./pages/Privacy";
import { saveTest } from "./lib/tests-store";
import { fetchDeploymentConfig } from "./lib/serve-url";

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
          { path: "/login", element: <Login /> },
          { path: "/settings", element: <Settings /> },
          { path: "/accept-invitation/:id", element: <AcceptInvitation /> },
          { path: "/terms", element: <Terms /> },
          { path: "/privacy", element: <Privacy /> }
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

  it("claims a manage link explicitly, into a chosen org", async () => {
    const { encoded, statsSecret } = await makeSavedTest();
    window.location.hash = `#${statsSecret}`;
    const calls: string[] = [];
    stubServer(
      {
        "/account/me": () =>
          Response.json({
            userId: "u1",
            activeOrgId: "org-1",
            orgs: [
              { id: "org-1", name: "Personal" },
              { id: "org-2", name: "Agency" }
            ]
          }),
        "/auth/organization/set-active": () => Response.json({ ok: true }),
        "/account/keys": () =>
          Response.json({ kh: "k".repeat(64) }, { status: 201 }),
        "/account/tests": () => Response.json({ testId: "t" }, { status: 201 }),
        "/stats/": STATS_OK
      },
      calls
    );
    const container = render(`/manage/${encoded}`);
    // Nothing claims on its own: with several orgs an automatic claim
    // would silently pick one.
    await until(() => container.textContent?.includes("Add to") ?? false);
    expect(calls.filter(c => c.startsWith("POST /account"))).toEqual([]);
    // Choose the second org, then claim: the switch happens first.
    const select = container.querySelector(
      'select[aria-label="Organization to add this test to"]'
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value"
    )!.set!;
    setter.call(select, "org-2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await until(
      () => container.textContent?.includes("Add to Agency") ?? false
    );
    [...container.querySelectorAll("button")]
      .find(button => button.textContent?.includes("Add to Agency"))!
      .click();
    await until(
      () => container.textContent?.includes("Saved to Agency") ?? false
    );
    expect(calls).toContain("POST /auth/organization/set-active");
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

describe("the login page", () => {
  function setValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("signs in with a password, and surfaces a wrong one", async () => {
    const calls: string[] = [];
    stubServer(
      {
        "/account/me": () =>
          Response.json({ error: "sign in required" }, { status: 401 }),
        "/auth/sign-in/email": () =>
          Response.json({ error: "invalid email or password" }, { status: 401 })
      },
      calls
    );
    const container = render("/login?next=/tests");
    await until(() => container.querySelector("#email") !== null);
    setValue(container.querySelector("#email")!, "pw@example.com");
    setValue(container.querySelector("#password")!, "wrong-password");
    const submit = [...container.querySelectorAll("button")].find(
      button => button.textContent?.trim() === "Sign in"
    )!;
    submit.click();
    await until(
      () =>
        container.textContent?.includes("invalid email or password") ?? false
    );
    expect(calls).toContain("POST /auth/sign-in/email");
  });

  it("registers through the toggle and lands on the verify notice", async () => {
    const calls: string[] = [];
    stubServer(
      {
        "/account/me": () =>
          Response.json({ error: "sign in required" }, { status: 401 }),
        "/auth/sign-up/email": () => Response.json({ user: { id: "u1" } })
      },
      calls
    );
    const container = render("/login");
    await until(() => container.querySelector("#email") !== null);
    [...container.querySelectorAll("button")]
      .find(button => button.textContent?.includes("No account yet"))!
      .click();
    await until(
      () => container.textContent?.includes("Create an account") ?? false
    );
    setValue(container.querySelector("#email")!, "new@example.com");
    setValue(container.querySelector("#password")!, "long-enough-pw");
    (
      container.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
    [...container.querySelectorAll("button")]
      .find(button => button.textContent?.trim() === "Create account")!
      .click();
    // No redirect: registration finishes in the inbox.
    await until(
      () => container.textContent?.includes("verification link") ?? false
    );
    expect(calls).toContain("POST /auth/sign-up/email");
  });
});

describe("the settings page", () => {
  it("shows the SDK snippet with the real key and serve origin", async () => {
    const PK = "pk_uitestkeyabcdefghijklmno";
    stubServer({
      "/account/me": () =>
        Response.json({ userId: "u1", activeOrgId: "org-1", orgs: [] }),
      "/account/domains": () => Response.json({ domains: [] }),
      "/account/publishable-keys": () =>
        Response.json({
          keys: [{ key: PK, label: null, createdAt: Date.now() }]
        }),
      "/config": () =>
        Response.json({ serveUrl: "https://serve.example", region: null })
    });
    const container = render("/settings");
    // The serve origin arrives async from /config; wait for the final
    // render, not the first (this exact race failed once on CI).
    await until(
      () =>
        [...container.querySelectorAll("pre")].some(pre =>
          pre.textContent?.includes("https://serve.example/sdk.js")
        ) ?? false
    );
    const snippets = [...container.querySelectorAll("pre")]
      .map(pre => pre.textContent ?? "")
      .join("\n");
    expect(snippets).toContain(`data-publishable-key="${PK}"`);
    expect(snippets).toContain("window.livevariant.sdk.createTest");
  });
});

describe("the org switcher", () => {
  it("lists memberships and sets the active org on change", async () => {
    const calls: string[] = [];
    stubServer(
      {
        "/auth/organization/set-active": () => Response.json({ ok: true })
      },
      calls
    );
    // Driven directly so the post-switch reload is injectable: a real
    // location.reload would blow away the test page itself.
    const switched: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    root.render(
      <OrgSwitcher
        account={{
          ready: true,
          available: true,
          me: {
            userId: "u1",
            activeOrgId: "org-1",
            orgs: [
              { id: "org-1", name: "Personal" },
              { id: "org-2", name: "Agency" }
            ]
          },
          refresh: () => undefined
        }}
        onSwitched={() => switched.push("reloaded")}
      />
    );
    await until(
      () =>
        container.querySelector('select[aria-label="Switch organization"]') !==
        null
    );
    const select = container.querySelector(
      'select[aria-label="Switch organization"]'
    ) as HTMLSelectElement;
    expect([...select.options].map(option => option.text)).toEqual([
      "Personal",
      "Agency"
    ]);
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value"
    )!.set!;
    setter.call(select, "org-2");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => switched.length === 1);
    expect(calls).toContain("POST /auth/organization/set-active");
  });

  it("renders one membership as plain text", async () => {
    stubServer({
      "/account/me": () =>
        Response.json({
          userId: "u1",
          activeOrgId: "org-1",
          orgs: [{ id: "org-1", name: "Personal" }]
        })
    });
    const container = render("/");
    await until(() => container.textContent?.includes("Personal") ?? false);
    expect(
      container.querySelector('select[aria-label="Switch organization"]')
    ).toBeNull();
  });
});

describe("google tag manager", () => {
  afterEach(() => {
    document.getElementById("lv-gtm")?.remove();
    delete (window as { dataLayer?: unknown }).dataLayer;
  });

  it("injects the container the deployment names, exactly once", async () => {
    stubServer({
      "/config": () =>
        Response.json({
          serveUrl: "https://serve.example",
          region: null,
          gtmId: "GTM-TEST123"
        })
    });
    render("/");
    await until(() => document.getElementById("lv-gtm") !== null);
    const script = document.getElementById("lv-gtm") as HTMLScriptElement;
    expect(script.src).toContain("googletagmanager.com/gtm.js?id=GTM-TEST123");
    const dataLayer = (window as { dataLayer?: unknown[] }).dataLayer ?? [];
    expect(
      dataLayer.some(entry => (entry as { event?: string }).event === "gtm.js")
    ).toBe(true);
  });

  it("rejects a lowercase id (container ids are uppercase, strictly)", async () => {
    stubServer({
      "/config": () =>
        Response.json({
          serveUrl: "https://serve.example",
          region: null,
          gtmId: "gtm-lower99"
        })
    });
    const config = await fetchDeploymentConfig();
    expect(config.gtmId).toBeNull();
  });

  it("injects nothing without a container, or for a malformed one", async () => {
    stubServer({
      "/config": () =>
        Response.json({
          serveUrl: "https://serve.example",
          region: null,
          gtmId: "https://evil.example/x.js"
        })
    });
    render("/");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(document.getElementById("lv-gtm")).toBeNull();
  });
});

describe("the magic-link alternative", () => {
  it("is always clickable: empty email explains and focuses the field", async () => {
    const calls: string[] = [];
    stubServer(
      {
        "/account/me": () =>
          Response.json({ error: "sign in required" }, { status: 401 })
      },
      calls
    );
    const container = render("/login");
    await until(() => container.querySelector("#email") !== null);
    const magic = [...container.querySelectorAll("button")].find(button =>
      button.textContent?.includes("sign-in link")
    )!;
    expect(magic.hasAttribute("disabled")).toBe(false);
    magic.click();
    await until(
      () =>
        container.textContent?.includes("Enter your email above first") ?? false
    );
    expect(calls).not.toContain("POST /auth/sign-in/magic-link");
    expect(document.activeElement?.id).toBe("email");
  });

  it("sends the link once the email is there", async () => {
    const calls: string[] = [];
    stubServer(
      {
        "/account/me": () =>
          Response.json({ error: "sign in required" }, { status: 401 }),
        "/auth/sign-in/magic-link": () => Response.json({ status: true })
      },
      calls
    );
    const container = render("/login");
    await until(() => container.querySelector("#email") !== null);
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    const email = container.querySelector("#email") as HTMLInputElement;
    setter.call(email, "magic@example.com");
    email.dispatchEvent(new Event("input", { bubbles: true }));
    [...container.querySelectorAll("button")]
      .find(button => button.textContent?.includes("sign-in link"))!
      .click();
    await until(
      () => container.textContent?.includes("Check your inbox") ?? false
    );
    expect(calls).toContain("POST /auth/sign-in/magic-link");
  });
});

describe("accepting an invitation", () => {
  it("never paints 'not found' over a join that succeeded", async () => {
    // The consumed-invitation trap: after acceptance the invitation no
    // longer loads, and a loader refire used to surface that as an
    // error next to the success message.
    let acceptedOnServer = false;
    stubServer({
      "/account/me": () =>
        Response.json({
          userId: "u1",
          activeOrgId: "org-1",
          orgs: [{ id: "org-1", name: "Personal" }]
        }),
      "/auth/organization/get-invitation": () =>
        acceptedOnServer
          ? Response.json({ message: "Invitation not found" }, { status: 404 })
          : Response.json({
              id: "inv-1",
              email: "u1@example.com",
              role: "member",
              organizationId: "org-2",
              organizationName: "Agency",
              status: "pending"
            }),
      "/auth/organization/accept-invitation": () => {
        acceptedOnServer = true;
        return Response.json({ ok: true });
      },
      "/auth/organization/set-active": () => Response.json({ ok: true })
    });
    const container = render("/accept-invitation/inv-1");
    await until(() => container.textContent?.includes("Join Agency") ?? false);
    [...container.querySelectorAll("button")]
      .find(button => button.textContent?.includes("Join Agency"))!
      .click();
    await until(() => container.textContent?.includes("You joined") ?? false);
    // Give any stray refetch time to land before asserting its absence.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(container.textContent).not.toContain("not found");
    expect(container.textContent).not.toContain("could not be loaded");
  });

  it("loads a second invitation after the first was accepted", async () => {
    // Acceptance is keyed to the invitation id: pointing the same
    // mounted page at another invite link must load it, not keep
    // showing the first one's success state.
    const joined = new Set<string>();
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          window.location.origin
        );
        void init;
        if (url.pathname === "/account/me") {
          return Response.json({
            userId: "u1",
            activeOrgId: "org-1",
            orgs: [{ id: "org-1", name: "Personal" }]
          });
        }
        if (url.pathname === "/auth/organization/get-invitation") {
          const id = url.searchParams.get("id") ?? "";
          if (joined.has(id)) {
            return Response.json(
              { message: "Invitation not found" },
              { status: 404 }
            );
          }
          return Response.json({
            id,
            email: "u1@example.com",
            role: "member",
            organizationId: id === "inv-1" ? "org-2" : "org-3",
            organizationName: id === "inv-1" ? "Agency" : "Beta",
            status: "pending"
          });
        }
        if (url.pathname === "/auth/organization/accept-invitation") {
          joined.add("inv-1");
          return Response.json({ ok: true });
        }
        if (url.pathname === "/auth/organization/set-active") {
          return Response.json({ ok: true });
        }
        return new Response("404", { status: 404 });
      }
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const router = createMemoryRouter(
      [
        {
          element: <AppLayout />,
          children: [
            { path: "/accept-invitation/:id", element: <AcceptInvitation /> },
            { path: "/tests", element: <div /> }
          ]
        }
      ],
      { initialEntries: ["/accept-invitation/inv-1"] }
    );
    const root = createRoot(container);
    roots.push(root);
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    );
    await until(() => container.textContent?.includes("Join Agency") ?? false);
    [...container.querySelectorAll("button")]
      .find(button => button.textContent?.includes("Join Agency"))!
      .click();
    await until(() => container.textContent?.includes("You joined") ?? false);
    await router.navigate("/accept-invitation/inv-2");
    await until(() => container.textContent?.includes("Join Beta") ?? false);
  });
});

describe("domain verification feedback", () => {
  it("shows the server's reason when a check finds nothing", async () => {
    stubServer({
      "/account/me": () =>
        Response.json({
          userId: "u1",
          activeOrgId: "org-1",
          orgs: [{ id: "org-1", name: "Personal" }]
        }),
      "/account/domains/example.com/verify": () =>
        Response.json({
          domain: "example.com",
          verified: false,
          reason: "no TXT record matched the verification token"
        }),
      "/account/domains": () =>
        Response.json({
          domains: [
            {
              domain: "example.com",
              verifiedAt: null,
              checkedAt: null,
              createdAt: 1,
              method: "dns-txt",
              token: "tok",
              instructions: {
                dnsTxt: {
                  name: "_livevariant.example.com",
                  type: "TXT",
                  value: "livevariant-site-verification=tok"
                },
                wellKnown: {
                  url: "https://example.com/.well-known/livevariant-verification.txt",
                  body: "tok"
                }
              }
            }
          ]
        }),
      "/account/publishable-keys": () => Response.json({ keys: [] }),
      "/config": () =>
        Response.json({ serveUrl: "https://serve.example", region: null })
    });
    const container = render("/settings");
    await until(() => container.textContent?.includes("Check now") ?? false);
    [...container.querySelectorAll("button")]
      .find(button => button.textContent?.trim() === "Check now")!
      .click();
    await until(
      () =>
        container.textContent?.includes(
          "no TXT record matched the verification token"
        ) ?? false
    );
  });
});

describe("terms and privacy", () => {
  it("registration requires agreeing to the terms", async () => {
    stubServer({
      "/account/me": () =>
        Response.json({ error: "sign in required" }, { status: 401 })
    });
    const container = render("/login");
    await until(() => container.textContent?.includes("Sign in") ?? false);
    [...container.querySelectorAll("button")]
      .find(b => b.textContent?.includes("No account yet"))!
      .click();
    await until(
      () => container.textContent?.includes("Create an account") ?? false
    );
    // Fill credentials; the button must STILL be disabled until the
    // terms are agreed to.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    for (const [id, value] of [
      ["#email", "new@example.com"],
      ["#password", "longenoughpw"]
    ] as const) {
      const input = container.querySelector(id) as HTMLInputElement;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const submit = [...container.querySelectorAll("button")].find(b =>
      b.textContent?.includes("Create account")
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(container.querySelector('a[href="/privacy"]')).not.toBeNull();
    const checkbox = container.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    checkbox.click();
    await until(() => !submit.disabled);
  });

  it("serves the terms and privacy pages with the liability language", async () => {
    stubServer({
      "/account/me": () =>
        Response.json({ error: "sign in required" }, { status: 401 })
    });
    const terms = render("/terms");
    await until(() => terms.textContent?.includes("Terms of Service") ?? false);
    expect(terms.textContent).toContain("NO WARRANTY FOR THE SERVICE");
    expect(terms.textContent).toContain("hi@livevariant.com");
    const privacy = render("/privacy");
    await until(() => privacy.textContent?.includes("Privacy Policy") ?? false);
    expect(privacy.textContent).toContain("hashed");
  });
});
