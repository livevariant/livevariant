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
