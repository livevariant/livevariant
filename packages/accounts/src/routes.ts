/**
 * The account surface: Better Auth mounted at /auth, the registry REST
 * under /account. Cookies exist on exactly these two prefixes, with
 * credentialed CORS scoped to the dashboard origin, and both prefixes
 * are host-gated: on the serving domain they answer 404, so no cookie
 * is ever scoped near attacker-authored redirects.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { decodeConfig, hashStatsSecret } from "@livevariant/core";
import {
  generateVerificationToken,
  normalizeDomain,
  verificationInstructions,
  verifyDomain
} from "./domains.js";
import {
  addDomain,
  claimKey,
  createPublishableKey,
  listDomains,
  listKeys,
  listPublishableKeys,
  listTests,
  markDomainVerified,
  registerTest,
  releaseKey,
  removeDomain,
  removePublishableKey,
  removeTest,
  setLockReads
} from "./registry.js";
import { member, organization } from "./schema.js";
import type { Auth, Db } from "./auth.js";
import type { RenderPage } from "./domains.js";
import type { RegistryProvider } from "./provider.js";

export interface AccountRoutesDeps {
  db: Db;
  auth: () => Auth;
  provider: RegistryProvider;
  /** Origins whose /a/ URLs are this deployment's own assets. */
  assetOrigins: string[];
  /** Dashboard origin; the only host these routes answer on. */
  baseUrl: string;
  /** JS-rendered fetch for the tag-manager verification path. */
  renderPage?: RenderPage;
}

const claimSchema = z.object({
  statsSecret: z.string().min(8).max(256),
  label: z.string().max(120).optional()
});

const lockSchema = z.object({ lockReads: z.boolean() });

const registerSchema = z.object({
  encoded: z.string().min(1).max(8192),
  name: z.string().max(200).optional()
});

const domainSchema = z.object({ domain: z.string().min(3).max(253) });

interface Caller {
  userId: string;
  /** Memberships as orgId -> role. */
  orgs: Map<string, string>;
  /** The org this request acts on (active if set, else first). */
  orgId: string | null;
}

export function createAccountRoutes(deps: AccountRoutesDeps): Hono {
  const app = new Hono();
  const dashboardHost = new URL(deps.baseUrl).host;

  // Host gate before anything else: these prefixes exist only on the
  // dashboard host. 404 (not 403) so the serving domain reveals nothing.
  const hostGate = async (
    c: Parameters<Parameters<Hono["use"]>[1]>[0],
    next: () => Promise<void>
  ): Promise<Response | undefined> => {
    if (new URL(c.req.url).host !== dashboardHost) {
      return c.notFound();
    }
    await next();
    return undefined;
  };
  app.use("/auth/*", hostGate);
  app.use("/account/*", hostGate);

  // Credentialed CORS, never "*": the dashboard is same-origin in
  // production, but local dev serves it from the Vite port.
  const credCors = cors({
    origin: origin => (origin === deps.baseUrl ? origin : ""),
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type"]
  });
  app.use("/auth/*", credCors);
  app.use("/account/*", credCors);

  app.on(["GET", "POST"], "/auth/*", c => deps.auth().handler(c.req.raw));

  async function caller(c: { req: { raw: Request } }): Promise<Caller | null> {
    const session = await deps
      .auth()
      .api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return null;
    }
    const memberships = await deps.db.query.member.findMany({
      where: (row, { eq }) => eq(row.userId, session.user.id)
    });
    const orgs = new Map(memberships.map(m => [m.organizationId, m.role]));
    const active = session.session.activeOrganizationId;
    const orgId =
      active && orgs.has(active)
        ? active
        : (memberships[0]?.organizationId ?? null);
    return { userId: session.user.id, orgs, orgId };
  }

  /**
   * Signing in never creates an org; the first WRITE does. A personal
   * org made on demand keeps "log in and claim" one step without
   * writing anything for people who only ever read.
   */
  async function ensureOrg(who: Caller): Promise<string> {
    if (who.orgId) {
      return who.orgId;
    }
    const orgId = crypto.randomUUID();
    await deps.db.insert(organization).values({
      id: orgId,
      name: "Personal",
      slug: `personal-${orgId.slice(0, 8)}`,
      createdAt: new Date()
    });
    await deps.db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: who.userId,
      role: "owner",
      createdAt: new Date()
    });
    who.orgs.set(orgId, "owner");
    who.orgId = orgId;
    return orgId;
  }

  function canAdmin(who: Caller, orgId: string): boolean {
    const role = who.orgs.get(orgId);
    return role === "owner" || role === "admin";
  }

  const unauthorized = { error: "sign in required" } as const;

  app.get("/account/me", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const orgs = await deps.db.query.organization.findMany({
      where: (row, { inArray }) =>
        inArray(row.id, [...who.orgs.keys()].concat("-"))
    });
    return c.json({
      userId: who.userId,
      activeOrgId: who.orgId,
      orgs: orgs.map(org => ({
        id: org.id,
        name: org.name,
        role: who.orgs.get(org.id)
      }))
    });
  });

  app.post("/account/keys", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const body = claimSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "invalid request" }, 400);
    }
    const orgId = await ensureOrg(who);
    // One hash function in the whole system; the raw secret is never
    // stored and never logged.
    const kh = await hashStatsSecret(body.data.statsSecret);
    const result = await claimKey(deps.db, {
      kh,
      orgId,
      userId: who.userId,
      label: body.data.label
    });
    if (result.status === "conflict") {
      return c.json({ error: "this key is already claimed" }, 409);
    }
    deps.provider.invalidateKey(kh);
    return c.json(
      { ...result.key, orgId },
      result.status === "claimed" ? 201 : 200
    );
  });

  app.get("/account/keys", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    if (!who.orgId) {
      return c.json({ keys: [] });
    }
    return c.json({ keys: await listKeys(deps.db, who.orgId) });
  });

  app.patch("/account/keys/:kh", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const body = lockSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "invalid request" }, 400);
    }
    const kh = c.req.param("kh");
    if (!who.orgId || !canAdmin(who, who.orgId)) {
      return c.json({ error: "requires an owner or admin role" }, 403);
    }
    const changed = await setLockReads(
      deps.db,
      who.orgId,
      kh,
      body.data.lockReads
    );
    if (!changed) {
      return c.json({ error: "no such key in this organization" }, 404);
    }
    deps.provider.invalidateKey(kh);
    return c.json({ kh, lockReads: body.data.lockReads });
  });

  app.delete("/account/keys/:kh", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const kh = c.req.param("kh");
    if (!who.orgId || !canAdmin(who, who.orgId)) {
      return c.json({ error: "requires an owner or admin role" }, 403);
    }
    const removed = await releaseKey(deps.db, who.orgId, kh);
    if (!removed) {
      return c.json({ error: "no such key in this organization" }, 404);
    }
    deps.provider.invalidateKey(kh);
    return c.json({ released: kh });
  });

  app.get("/account/tests", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    if (!who.orgId) {
      return c.json({ tests: [], nextCursor: null });
    }
    const limit = Number(c.req.query("limit") ?? "25");
    return c.json(
      await listTests(deps.db, who.orgId, {
        q: c.req.query("q") || undefined,
        cursor: c.req.query("cursor") || undefined,
        limit: Number.isFinite(limit) ? limit : 25
      })
    );
  });

  app.post("/account/tests", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const body = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "invalid request" }, 400);
    }
    let decoded;
    try {
      decoded = await decodeConfig(body.data.encoded);
    } catch {
      return c.json({ error: "that is not a test config" }, 400);
    }
    const kh = decoded.config.statsKeyHash;
    // Registration requires ownership of the test's key: a config is a
    // public artifact, so knowing one proves nothing. Keyless tests are
    // registered only through the verified publishable-key path.
    if (!kh) {
      return c.json(
        { error: "keyless tests cannot be registered from the dashboard" },
        400
      );
    }
    const orgId = await ensureOrg(who);
    const policy = await deps.provider.keyPolicy(kh);
    if (!policy || policy.orgId !== orgId) {
      return c.json({ error: "claim this test's stats key first" }, 403);
    }
    await registerTest(deps.db, deps.assetOrigins, {
      testId: decoded.testId,
      orgId,
      kh,
      name: body.data.name ?? decoded.config.name,
      encoded: body.data.encoded,
      region: decoded.config.region
    });
    deps.provider.invalidateTest(decoded.testId);
    return c.json({ testId: decoded.testId, orgId }, 201);
  });

  app.post("/account/publishable-keys", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      label?: unknown;
    };
    const label =
      typeof body.label === "string" ? body.label.slice(0, 120) : undefined;
    const orgId = await ensureOrg(who);
    return c.json(await createPublishableKey(deps.db, orgId, label), 201);
  });

  app.get("/account/publishable-keys", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    if (!who.orgId) {
      return c.json({ keys: [] });
    }
    return c.json({ keys: await listPublishableKeys(deps.db, who.orgId) });
  });

  app.delete("/account/tests/:testId", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    if (!who.orgId) {
      return c.json({ error: "no organization" }, 404);
    }
    // The symmetric right to pk-based registration: a public key lets
    // anyone put a test on this list, so the org can always take one
    // off. Removes the LISTING only; the test itself keeps serving.
    const removed = await removeTest(deps.db, {
      testId: c.req.param("testId"),
      orgId: who.orgId
    });
    if (!removed) {
      return c.json({ error: "not in this organization's list" }, 404);
    }
    deps.provider.invalidateTest(c.req.param("testId"));
    return c.json({ removed: true });
  });

  app.delete("/account/publishable-keys/:key", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    if (!who.orgId || !canAdmin(who, who.orgId)) {
      return c.json({ error: "requires an owner or admin role" }, 403);
    }
    const removed = await removePublishableKey(
      deps.db,
      who.orgId,
      c.req.param("key")
    );
    if (!removed) {
      return c.json({ error: "no such key in this organization" }, 404);
    }
    return c.json({ removed: c.req.param("key") });
  });

  app.post("/account/domains", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const body = domainSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "invalid request" }, 400);
    }
    const normalized = normalizeDomain(body.data.domain);
    if ("error" in normalized) {
      return c.json({ error: normalized.error }, 400);
    }
    const orgId = await ensureOrg(who);
    const token = generateVerificationToken();
    const outcome = await addDomain(deps.db, {
      domain: normalized.domain,
      orgId,
      token,
      method: "dns-txt"
    });
    if (outcome === "conflict") {
      return c.json(
        { error: "this domain is already registered by another account" },
        409
      );
    }
    const existing =
      outcome === "exists"
        ? (await listDomains(deps.db, orgId)).find(
            d => d.domain === normalized.domain
          )
        : null;
    const effectiveToken = existing?.token ?? token;
    return c.json(
      {
        domain: normalized.domain,
        verified: existing?.verifiedAt != null,
        instructions: verificationInstructions(
          normalized.domain,
          effectiveToken
        )
      },
      outcome === "added" ? 201 : 200
    );
  });

  app.get("/account/domains", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    if (!who.orgId) {
      return c.json({ domains: [] });
    }
    const rows = await listDomains(deps.db, who.orgId);
    return c.json({
      domains: rows.map(row => ({
        ...row,
        instructions: verificationInstructions(row.domain, row.token)
      }))
    });
  });

  app.post("/account/domains/:domain/verify", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    if (!who.orgId) {
      return c.json({ error: "no organization" }, 404);
    }
    const domain = c.req.param("domain").toLowerCase();
    const rows = await listDomains(deps.db, who.orgId);
    const row = rows.find(d => d.domain === domain);
    if (!row) {
      return c.json({ error: "no such domain in this organization" }, 404);
    }
    // The org's publishable keys ride along: finding one in the
    // homepage source is the zero-setup verification method.
    const keys = (await listPublishableKeys(deps.db, who.orgId)).map(
      k => k.key
    );
    const result = await verifyDomain(
      domain,
      row.token,
      fetch,
      keys,
      deps.renderPage
    );
    await markDomainVerified(
      deps.db,
      who.orgId,
      domain,
      result.method ?? row.method,
      result.ok
    );
    deps.provider.invalidateDomain(domain);
    // A completed check that found nothing is a RESULT, not an HTTP
    // error: 200 with verified:false and the reason, so the dashboard
    // can say what to do next instead of "request failed".
    if (!result.ok) {
      return c.json({ domain, verified: false, reason: result.reason });
    }
    return c.json({ domain, verified: true, method: result.method });
  });

  app.delete("/account/domains/:domain", async c => {
    const who = await caller(c);
    if (!who) {
      return c.json(unauthorized, 401);
    }
    const domain = c.req.param("domain").toLowerCase();
    if (!who.orgId || !canAdmin(who, who.orgId)) {
      return c.json({ error: "requires an owner or admin role" }, 403);
    }
    const removed = await removeDomain(deps.db, who.orgId, domain);
    if (!removed) {
      return c.json({ error: "no such domain in this organization" }, 404);
    }
    deps.provider.invalidateDomain(domain);
    return c.json({ removed: domain });
  });

  return app;
}
