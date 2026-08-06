import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import {
  encodeConfig,
  generateStatsSecret,
  hashStatsSecret
} from "@livevariant/core";
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
    sendEmail: async () => undefined
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
      sendEmail: async email => {
        const url = email.text.match(/https?:\/\/\S+/)?.[0];
        if (url) {
          links.push(url);
        }
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
  it("registers, verifies the email, signs in, claims", async () => {
    const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
    const emails: Array<{ subject: string; text: string }> = [];
    const flow = createAccounts({
      db: d1,
      baseUrl: DASHBOARD,
      secret: "c".repeat(48),
      sendEmail: async email => {
        emails.push(email);
      }
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
    // Registration is not done until the address is proven: the
    // verification email went out, and sign-in refuses until its link
    // is followed.
    expect(emails.map(e => e.subject).join()).toContain("Verify");
    const early = await flow.routes.request(`${DASHBOARD}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: DASHBOARD },
      body: JSON.stringify({
        email: "pw@example.com",
        password: "correct-horse-battery"
      })
    });
    expect(early.status).toBe(403);
    const verifyUrl = emails
      .map(e => e.text.match(/https?:\/\/\S+/)?.[0])
      .find(Boolean)!;
    const parsed = new URL(verifyUrl);
    const verify = await flow.routes.request(
      `${DASHBOARD}${parsed.pathname}${parsed.search}`,
      { headers: { origin: DASHBOARD } }
    );
    expect([200, 302]).toContain(verify.status);

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

describe("multiple organizations, end to end", () => {
  it("switching the active org changes what claims and lists act on", async () => {
    const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
    const emails: Array<{ to: string; subject: string; text: string }> = [];
    const flow = createAccounts({
      db: d1,
      baseUrl: DASHBOARD,
      secret: "d".repeat(48),
      sendEmail: async email => {
        emails.push(email);
      }
    });
    const post = (path: string, body: unknown, cookie?: string) =>
      flow.routes.request(`${DASHBOARD}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: DASHBOARD,
          ...(cookie ? { cookie } : {})
        },
        body: JSON.stringify(body)
      });
    const cookieOf = (res: Response, previous = "") => {
      const set = res.headers.get("set-cookie");
      if (!set) {
        return previous;
      }
      const jar = new Map<string, string>(
        previous
          .split("; ")
          .filter(Boolean)
          .map(pair => [pair.split("=")[0], pair] as [string, string])
      );
      for (const part of set.split(",")) {
        const pair = part.split(";")[0].trim();
        if (pair.includes("=")) {
          jar.set(pair.split("=")[0], pair);
        }
      }
      return [...jar.values()].join("; ");
    };

    // Owner signs up (verify via emailed link) and signs in.
    await post("/auth/sign-up/email", {
      name: "owner",
      email: "owner@example.com",
      password: "owner-password-long"
    });
    const ownerVerify = emails
      .map(e => e.text.match(/https?:\/\/\S+/)?.[0])
      .find(Boolean)!;
    const ownerParsed = new URL(ownerVerify);
    await flow.routes.request(
      `${DASHBOARD}${ownerParsed.pathname}${ownerParsed.search}`,
      { headers: { origin: DASHBOARD } }
    );
    const ownerSignIn = await post("/auth/sign-in/email", {
      email: "owner@example.com",
      password: "owner-password-long"
    });
    let ownerCookie = cookieOf(ownerSignIn);

    // Claim under the auto-created personal org.
    const claimA = await post(
      "/account/keys",
      { statsSecret: "org-switch-secret-a" },
      ownerCookie
    );
    expect(claimA.status).toBe(201);

    // Create a second org and make it active.
    const created = await post(
      "/auth/organization/create",
      { name: "Second Org", slug: `second-${Date.now()}` },
      ownerCookie
    );
    expect(created.status).toBe(200);
    const org2 = ((await created.json()) as { id: string }).id;
    const setActive = await post(
      "/auth/organization/set-active",
      { organizationId: org2 },
      ownerCookie
    );
    ownerCookie = cookieOf(setActive, ownerCookie);

    // The key claimed under org 1 is not in org 2's list; a new claim
    // lands in org 2.
    const keysInOrg2 = await flow.routes.request(`${DASHBOARD}/account/keys`, {
      headers: { cookie: ownerCookie }
    });
    expect(
      ((await keysInOrg2.json()) as { keys: unknown[] }).keys
    ).toHaveLength(0);
    const claimB = await post(
      "/account/keys",
      { statsSecret: "org-switch-secret-b" },
      ownerCookie
    );
    expect(claimB.status).toBe(201);
    expect(((await claimB.json()) as { orgId: string }).orgId).toBe(org2);

    // Invite a teammate into org 2; the email carries the accept URL.
    emails.length = 0;
    const invite = await post(
      "/auth/organization/invite-member",
      { email: "teammate@example.com", role: "member" },
      ownerCookie
    );
    expect(invite.status).toBe(200);
    expect(emails.map(e => e.subject).join()).toContain("invited you");
    const acceptUrl = emails
      .map(e => e.text.match(/https?:\/\/\S+accept-invitation\/\S+/)?.[0])
      .find(Boolean)!;
    const invitationId = acceptUrl.split("/accept-invitation/")[1];

    // The teammate registers, verifies, signs in, accepts.
    emails.length = 0;
    await post("/auth/sign-up/email", {
      name: "teammate",
      email: "teammate@example.com",
      password: "teammate-password-1"
    });
    const mateVerify = emails
      .map(e => e.text.match(/https?:\/\/\S+/)?.[0])
      .find(Boolean)!;
    const mateParsed = new URL(mateVerify);
    await flow.routes.request(
      `${DASHBOARD}${mateParsed.pathname}${mateParsed.search}`,
      { headers: { origin: DASHBOARD } }
    );
    const mateSignIn = await post("/auth/sign-in/email", {
      email: "teammate@example.com",
      password: "teammate-password-1"
    });
    let mateCookie = cookieOf(mateSignIn);
    const accept = await post(
      "/auth/organization/accept-invitation",
      { invitationId },
      mateCookie
    );
    expect(accept.status).toBe(200);
    const mateActive = await post(
      "/auth/organization/set-active",
      { organizationId: org2 },
      mateCookie
    );
    mateCookie = cookieOf(mateActive, mateCookie);

    // Membership is real: the teammate sees org 2's key.
    const mateKeys = await flow.routes.request(`${DASHBOARD}/account/keys`, {
      headers: { cookie: mateCookie }
    });
    const mateList = (await mateKeys.json()) as {
      keys: Array<{ orgId?: string }>;
    };
    expect(mateList.keys).toHaveLength(1);
  });
});

describe("agent registration: secret proves, publishable key names", () => {
  it("registers with the pair, and refuses every partial authority", async () => {
    const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
    const emails: Array<{ to: string; subject: string; text: string }> = [];
    const flow = createAccounts({
      db: d1,
      baseUrl: DASHBOARD,
      secret: "e".repeat(48),
      sendEmail: async email => {
        emails.push(email);
      }
    });
    const post = (path: string, body: unknown, cookie?: string) =>
      flow.routes.request(`${DASHBOARD}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: DASHBOARD,
          ...(cookie ? { cookie } : {})
        },
        body: JSON.stringify(body)
      });
    const cookieOf = (res: Response, previous = "") => {
      const set = res.headers.get("set-cookie");
      if (!set) {
        return previous;
      }
      const jar = new Map<string, string>(
        previous
          .split("; ")
          .filter(Boolean)
          .map(pair => [pair.split("=")[0], pair] as [string, string])
      );
      for (const part of set.split(",")) {
        const pair = part.split(";")[0].trim();
        if (pair.includes("=")) {
          jar.set(pair.split("=")[0], pair);
        }
      }
      return [...jar.values()].join("; ");
    };

    // A user with an org and a publishable key.
    await post("/auth/sign-up/email", {
      name: "agentuser",
      email: "agent@example.com",
      password: "agent-password-long"
    });
    const verify = emails
      .map(e => e.text.match(/https?:\/\/\S+/)?.[0])
      .find(Boolean)!;
    const parsed = new URL(verify);
    await flow.routes.request(
      `${DASHBOARD}${parsed.pathname}${parsed.search}`,
      { headers: { origin: DASHBOARD } }
    );
    const signIn = await post("/auth/sign-in/email", {
      email: "agent@example.com",
      password: "agent-password-long"
    });
    const cookie = cookieOf(signIn);
    const pkRes = await post("/account/publishable-keys", {}, cookie);
    expect(pkRes.status).toBe(201);
    const { key: pk } = (await pkRes.json()) as { key: string };

    // The agent-side artifacts: a test whose secret the agent minted.
    const statsSecret = generateStatsSecret();
    const { encoded, testId } = await encodeConfig({
      v: 2,
      name: "agent email test",
      variants: [
        { name: "a", image: "https://cdn.example/a.png" },
        { name: "b", image: "https://cdn.example/b.png" }
      ],
      statsKeyHash: await hashStatsSecret(statsSecret)
    } as never);

    // pk alone with a WRONG secret must fail: kh is public, so this is
    // exactly the stats-theft attempt the design refuses.
    const stolen = await flow.provider.registerWithSecret({
      encoded,
      statsSecret: "not-the-secret",
      publishableKey: pk
    });
    expect(stolen).toEqual({ ok: false, reason: "bad-secret" });

    // Secret with an unknown key: nothing to register into.
    const nowhere = await flow.provider.registerWithSecret({
      encoded,
      statsSecret,
      publishableKey: "pk_000000000000000000000000"
    });
    expect(nowhere).toEqual({ ok: false, reason: "unknown-key" });

    // The pair registers; idempotent on repeat.
    const first = await flow.provider.registerWithSecret({
      encoded,
      statsSecret,
      publishableKey: pk
    });
    expect(first).toMatchObject({ ok: true, testId });
    const again = await flow.provider.registerWithSecret({
      encoded,
      statsSecret,
      publishableKey: pk
    });
    expect(again).toMatchObject({ ok: true, testId });

    // The dashboard sees it: listed, and stats-authorized via keyring.
    const list = await flow.routes.request(`${DASHBOARD}/account/tests`, {
      headers: { origin: DASHBOARD, cookie }
    });
    const listed = (await list.json()) as { tests: { testId: string }[] };
    expect(listed.tests.map(t => t.testId)).toContain(testId);
    const policy = await flow.provider.keyPolicy(
      await hashStatsSecret(statsSecret)
    );
    expect(policy).not.toBeNull();

    // A keyless config has nothing to prove with.
    const keyless = await encodeConfig({
      v: 2,
      variants: [
        { name: "a", url: "https://example.com/a" },
        { name: "b", url: "https://example.com/b" }
      ]
    } as never);
    const refused = await flow.provider.registerWithSecret({
      encoded: keyless.encoded,
      statsSecret,
      publishableKey: pk
    });
    expect(refused).toEqual({ ok: false, reason: "bad-config" });
  });
});

describe("removing a registered test", () => {
  it("the org can always take a listing off, and only its own", async () => {
    const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
    const emails: Array<{ to: string; subject: string; text: string }> = [];
    const flow = createAccounts({
      db: d1,
      baseUrl: DASHBOARD,
      secret: "f".repeat(48),
      sendEmail: async email => {
        emails.push(email);
      }
    });
    const post = (path: string, body: unknown, cookie?: string) =>
      flow.routes.request(`${DASHBOARD}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: DASHBOARD,
          ...(cookie ? { cookie } : {})
        },
        body: JSON.stringify(body)
      });
    const cookieOf = (res: Response) =>
      (res.headers.get("set-cookie") ?? "")
        .split(",")
        .map(part => part.split(";")[0].trim())
        .filter(pair => pair.includes("="))
        .join("; ");

    await post("/auth/sign-up/email", {
      name: "remover",
      email: "remover@example.com",
      password: "remover-password-long"
    });
    const verify = emails
      .map(e => e.text.match(/https?:\/\/\S+/)?.[0])
      .find(Boolean)!;
    const parsed = new URL(verify);
    await flow.routes.request(
      `${DASHBOARD}${parsed.pathname}${parsed.search}`,
      { headers: { origin: DASHBOARD } }
    );
    const cookie = cookieOf(
      await post("/auth/sign-in/email", {
        email: "remover@example.com",
        password: "remover-password-long"
      })
    );
    const { key: pk } = (await (
      await post("/account/publishable-keys", {}, cookie)
    ).json()) as { key: string };

    // A stranger registers a test into the org using the PUBLIC key:
    // exactly the spam vector removal exists for.
    const strangerSecret = generateStatsSecret();
    const spam = await encodeConfig({
      v: 2,
      name: "unwanted",
      variants: [
        { name: "a", url: "https://spam.example/a" },
        { name: "b", url: "https://spam.example/b" }
      ],
      statsKeyHash: await hashStatsSecret(strangerSecret)
    } as never);
    const injected = await flow.provider.registerWithSecret({
      encoded: spam.encoded,
      statsSecret: strangerSecret,
      publishableKey: pk
    });
    expect(injected).toMatchObject({ ok: true });

    const removed = await flow.routes.request(
      `${DASHBOARD}/account/tests/${spam.testId}`,
      { method: "DELETE", headers: { origin: DASHBOARD, cookie } }
    );
    expect(removed.status).toBe(200);
    const list = (await (
      await flow.routes.request(`${DASHBOARD}/account/tests`, {
        headers: { origin: DASHBOARD, cookie }
      })
    ).json()) as { tests: { testId: string }[] };
    expect(list.tests.map(t => t.testId)).not.toContain(spam.testId);

    // Removing something not on this org's list is a 404, not a leak.
    const foreign = await flow.routes.request(
      `${DASHBOARD}/account/tests/${"0".repeat(64)}`,
      { method: "DELETE", headers: { origin: DASHBOARD, cookie } }
    );
    expect(foreign.status).toBe(404);
  });
});
