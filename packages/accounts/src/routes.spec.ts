import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { createAccounts, type Accounts } from "./index.js";

/**
 * The route-shape regressions that keep the cookie boundary honest:
 * credentialed CORS answers with a concrete origin (a wildcard plus
 * credentials is dead on arrival per the Fetch spec), and the account
 * prefixes simply do not exist on the serving host.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const DASHBOARD = "https://dashboard.test";

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let accounts: Accounts;

beforeAll(async () => {
  proxy = await getPlatformProxy({
    configPath: join(root, "wrangler.jsonc"),
    environment: "production",
    persist: false
  });
  const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
  const dir = join(root, "packages", "accounts", "migrations");
  for (const file of readdirSync(dir)
    .filter(f => f.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(join(dir, file), "utf8").split(
      "--> statement-breakpoint"
    )) {
      if (statement.trim()) {
        await d1.prepare(statement.trim()).run();
      }
    }
  }
  accounts = createAccounts({
    db: d1,
    baseUrl: DASHBOARD,
    secret: "a".repeat(48),
    sendMagicLink: async () => undefined
  });
});

afterAll(async () => {
  await proxy.dispose();
});

describe("cookie boundary", () => {
  it("answers the auth preflight with a concrete origin and credentials", async () => {
    const res = await accounts.routes.request(
      `${DASHBOARD}/auth/sign-in/magic-link`,
      {
        method: "OPTIONS",
        headers: {
          origin: DASHBOARD,
          "access-control-request-method": "POST"
        }
      }
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("never answers a foreign origin's preflight", async () => {
    const res = await accounts.routes.request(
      `${DASHBOARD}/auth/sign-in/magic-link`,
      {
        method: "OPTIONS",
        headers: {
          origin: "https://stranger.test",
          "access-control-request-method": "POST"
        }
      }
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("404s both prefixes on the serving host", async () => {
    for (const path of ["/auth/session", "/account/keys"]) {
      const res = await accounts.routes.request(
        `https://serve.livevariant.link${path}`
      );
      expect(res.status).toBe(404);
    }
  });

  it("401s /account without a session on the dashboard host", async () => {
    const res = await accounts.routes.request(`${DASHBOARD}/account/keys`);
    expect(res.status).toBe(401);
  });
});

describe("the whole sign-in and claim flow, end to end", () => {
  it("magic link to session to claim to list", async () => {
    // A second Accounts instance with a recording mailer, same local D1.
    const links: string[] = [];
    const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
    const flow = createAccounts({
      db: d1,
      baseUrl: DASHBOARD,
      secret: "b".repeat(48),
      sendMagicLink: async (_to, url) => {
        links.push(url);
      }
    });

    const send = await flow.routes.request(
      `${DASHBOARD}/auth/sign-in/magic-link`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: DASHBOARD
        },
        body: JSON.stringify({
          email: "e2e@example.com",
          callbackURL: `${DASHBOARD}/tests`
        })
      }
    );
    expect(send.status).toBe(200);
    expect(links).toHaveLength(1);

    // The link the mail would carry, followed as the browser would.
    const verifyUrl = new URL(links[0]);
    const verify = await flow.routes.request(
      `${DASHBOARD}${verifyUrl.pathname}${verifyUrl.search}`,
      { headers: { origin: DASHBOARD } }
    );
    expect([200, 302]).toContain(verify.status);
    const setCookie = verify.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookie = setCookie!
      .split(",")
      .map(part => part.split(";")[0].trim())
      .join("; ");

    // Session-authenticated claim: personal org auto-created on first
    // write, key bound, list answers.
    const claim = await flow.routes.request(`${DASHBOARD}/account/keys`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: DASHBOARD
      },
      body: JSON.stringify({ statsSecret: "e2e-flow-secret", label: "e2e" })
    });
    expect(claim.status).toBe(201);
    const claimed = (await claim.json()) as { kh: string; orgId: string };
    expect(claimed.kh).toMatch(/^[0-9a-f]{64}$/);

    const list = await flow.routes.request(`${DASHBOARD}/account/keys`, {
      headers: { cookie }
    });
    expect(list.status).toBe(200);
    const keys = (await list.json()) as { keys: Array<{ kh: string }> };
    expect(keys.keys.some(k => k.kh === claimed.kh)).toBe(true);
  });
});

describe("password register and sign-in, end to end", () => {
  it("registers, signs in on a fresh client, claims", async () => {
    const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
    const flow = createAccounts({
      db: d1,
      baseUrl: DASHBOARD,
      secret: "c".repeat(48),
      sendMagicLink: async () => undefined
    });
    const register = await flow.routes.request(
      `${DASHBOARD}/auth/sign-up/email`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: DASHBOARD },
        body: JSON.stringify({
          name: "pw",
          email: "pw@example.com",
          password: "correct-horse-battery"
        })
      }
    );
    expect(register.status).toBe(200);

    // A fresh sign-in, as a new browser would: no cookies carried over.
    const signIn = await flow.routes.request(
      `${DASHBOARD}/auth/sign-in/email`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: DASHBOARD },
        body: JSON.stringify({
          email: "pw@example.com",
          password: "correct-horse-battery"
        })
      }
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .get("set-cookie")!
      .split(",")
      .map(part => part.split(";")[0].trim())
      .join("; ");

    const wrong = await flow.routes.request(`${DASHBOARD}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: DASHBOARD },
      body: JSON.stringify({
        email: "pw@example.com",
        password: "not-the-password"
      })
    });
    expect(wrong.status).toBe(401);

    const claim = await flow.routes.request(`${DASHBOARD}/account/keys`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: DASHBOARD
      },
      body: JSON.stringify({ statsSecret: "pw-flow-secret" })
    });
    expect(claim.status).toBe(201);
  });
});
