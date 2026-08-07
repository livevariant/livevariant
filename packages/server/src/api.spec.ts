import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { TOOLS, toolPath } from "@livevariant/tools";
import {
  configFromParams,
  encodeConfig,
  hashStatsSecret,
  mulberry32,
  sha256Hex
} from "@livevariant/core";
import { createApp } from "./app.js";
import { SERVER_VERSION } from "./version.js";
import { MemoryStore } from "./store/memory.js";

/**
 * The REST fallback exists for agents that cannot install an MCP server,
 * so what matters is that it exposes the same tools with the same answers,
 * and that the published document describes what is actually mounted.
 */
const A = "https://example.com/a";
const B = "https://example.com/b";

let app: Hono;

beforeEach(() => {
  app = createApp({ store: new MemoryStore(), rng: mulberry32(42) });
});

async function post(path: string, body: unknown) {
  return app.request(`https://livevariant.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("the tool API", () => {
  it("mounts every open tool; account tools need the capability", async () => {
    for (const tool of TOOLS) {
      const res = await post(toolPath(tool.name), {});
      if (tool.scope === "account") {
        // No accounts on this deployment: the tool does not exist, so
        // an agent is never shown something the server cannot answer.
        expect(res.status).toBe(404);
      } else {
        // Present, whatever it thinks of an empty body.
        expect(res.status).not.toBe(404);
      }
    }
  });

  it("builds a test over plain HTTP", async () => {
    const res = await post(toolPath("build_test"), {
      variants: [{ url: A }, { url: B }]
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, any>;
    expect(out.testId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.urls.serve).toBe(`https://livevariant.com/s/${out.config}`);
  });

  it("round-trips: a test built here actually serves here", async () => {
    // The proof that the API is not describing a parallel universe.
    const built = (await (
      await post(toolPath("build_test"), { variants: [{ url: A }, { url: B }] })
    ).json()) as Record<string, any>;

    const serve = await app.request(`/s/${built.config}?id=r1`, {
      headers: { accept: "text/html" }
    });
    expect(serve.status).toBe(302);
    expect(serve.headers.get("location")).toMatch(/example\.com\/(a|b)/);

    const stats = await app.request(`/stats/${built.config}`, {
      headers: { authorization: `Bearer ${built.statsSecret}` }
    });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as any).totalAssignments).toBe(1);
  });

  it("reports a bad body as a 400 with the reason", async () => {
    const res = await post(toolPath("build_test"), { variants: [{ url: A }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("invalid request");
    expect(JSON.stringify(body.details)).toMatch(/variants/);
  });

  it("turns a caller's mistake into a 400, not a 500", async () => {
    const res = await post(toolPath("inspect_test"), { test: "rubbish" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/not a LiveVariant test/);
  });

  it("publishes a spec describing exactly what is mounted", async () => {
    const res = await app.request("https://livevariant.com/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, any>;
    expect(Object.keys(doc.paths).sort()).toEqual(
      TOOLS.map(t => toolPath(t.name)).sort()
    );
    expect(doc.servers[0].url).toBe("https://livevariant.com");
  });

  it("treats a blank serving domain as no serving domain", async () => {
    // The deploy button offers LV_SERVE_URL empty and tells people to leave
    // it that way unless they run a second domain, so "" is expected input.
    // Passed through it built "/s/<config>", which in an email resolves
    // against the mail client and serves nothing.
    const blank = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1),
      serveUrl: "   "
    });
    const res = await blank.request("https://ab.internal/api/v1/build-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
    });
    const out = (await res.json()) as Record<string, any>;
    expect(out.urls.serve).toBe(`https://ab.internal/s/${out.config}`);
    // And the dashboard is told the same thing, or the builder would show
    // whitespace as the serving server.
    const config = await blank.request("https://ab.internal/config");
    expect(await config.json()).toEqual({
      serveUrl: "https://ab.internal",
      region: null,
      gtmId: null,
      publishableKey: null,
      server: SERVER_VERSION
    });
  });

  it("tells the dashboard where its links should point", async () => {
    // The builder is a static build and cannot know this at compile time,
    // so a hardcoded default would be wrong for the hosted service or for
    // every self-hoster, depending which way it was written.
    const res = await app.request("https://ab.internal/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      serveUrl: "https://ab.internal",
      region: null,
      gtmId: null,
      publishableKey: null,
      server: SERVER_VERSION
    });

    const split = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1),
      serveUrl: "https://livevariant.link"
    });
    const res2 = await split.request("https://livevariant.com/config");
    expect(await res2.json()).toEqual({
      serveUrl: "https://livevariant.link",
      region: null,
      gtmId: null,
      publishableKey: null,
      server: SERVER_VERSION
    });
  });

  it("serves the docs page", async () => {
    const res = await app.request("https://livevariant.com/docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("swagger-ui");
  });

  it("builds every URL from the origin the caller reached", async () => {
    // One domain doing everything is the default and needs no
    // configuration: deploy anywhere and the links are right, because they
    // are made from the request itself.
    const res = await app.request("https://ab.internal/api/v1/build-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
    });
    const out = (await res.json()) as Record<string, any>;
    expect(out.urls.serve).toBe(`https://ab.internal/s/${out.config}`);
    expect(out.urls.manage).toContain("https://ab.internal/manage/");
  });

  it("puts visitor links on the serving domain when there is one", async () => {
    // The only thing a separate serving domain changes is where visitors
    // are sent; the creator still manages the test where they found it.
    const split = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1),
      serveUrl: "https://livevariant.link"
    });
    const res = await split.request(
      "https://livevariant.com/api/v1/build-test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
      }
    );
    const out = (await res.json()) as Record<string, any>;
    expect(out.urls.serve).toContain("https://livevariant.link/s/");
    expect(out.emailTemplate.main.imageSrc).toContain(
      "https://livevariant.link/s?"
    );
    expect(out.urls.manage).toContain("https://livevariant.com/manage/");
  });

  it("reads its own stats without leaving the process", async () => {
    // The bug this pins: get_stats fetches /stats, and a Worker cannot
    // fetch its own hostname, so the injected fetch has to route back into
    // this same app. In production this surfaced as a 500.
    const built = (await (
      await post(toolPath("build_test"), { variants: [{ url: A }, { url: B }] })
    ).json()) as Record<string, any>;
    await app.request(`https://livevariant.com/s/${built.config}?id=r1`, {
      headers: { accept: "text/html" }
    });
    const res = await post(toolPath("get_stats"), {
      test: built.config,
      statsSecret: built.statsSecret
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).totalAssignments).toBe(1);
  });
});

describe("the API token gate", () => {
  const gated = () =>
    createApp({
      store: new MemoryStore(),
      rng: mulberry32(42),
      apiToken: "0".repeat(64)
    });

  it("401s tools and /mcp without the token, and answers with it", async () => {
    const app = gated();
    const anon = await app.request(`https://x.test${toolPath("build_test")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
    });
    expect(anon.status).toBe(401);
    const anonMcp = await app.request("https://x.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(anonMcp.status).toBe(401);
    const authed = await app.request(
      `https://x.test${toolPath("build_test")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${"0".repeat(64)}`
        },
        body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
      }
    );
    expect(authed.status).toBe(200);
  });

  it("leaves discovery and serving open", async () => {
    const app = gated();
    expect((await app.request("https://x.test/config")).status).toBe(200);
    expect((await app.request("https://x.test/openapi.json")).status).toBe(200);
    expect((await app.request("https://x.test/health")).status).toBe(200);
  });
});

describe("account-scoped tools with a provider", () => {
  const provider = {
    sessionOrgIds: async (req: Request) =>
      req.headers.get("cookie")?.includes("session=yes") ? ["org-1"] : [],
    keyPolicy: async () => null,
    testOrg: async () => null,
    listTests: async () => ({
      tests: [
        {
          testId: "t".repeat(64),
          name: "claimed test",
          encoded: "enc",
          region: null,
          addedAt: 1
        }
      ],
      nextCursor: null
    })
  };

  const withAccounts = () =>
    createApp({
      store: new MemoryStore(),
      rng: mulberry32(42),
      provider
    });

  it("mounts list_tests and resolves identity per call", async () => {
    const app = withAccounts();
    const anon = await app.request(`https://x.test${toolPath("list_tests")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    // Listed but unanswerable without identity: a clear 401, never an
    // empty list pretending to be an answer.
    expect(anon.status).toBe(401);
    const signed = await app.request(
      `https://x.test${toolPath("list_tests")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session=yes"
        },
        body: "{}"
      }
    );
    expect(signed.status).toBe(200);
    const body = (await signed.json()) as { tests: Array<{ name: string }> };
    expect(body.tests[0].name).toBe("claimed test");
  });
});

describe("GTM through /config", () => {
  it("names the container when configured, null otherwise", async () => {
    const withGtm = createApp({
      store: new MemoryStore(),
      rng: mulberry32(42),
      gtmId: "GTM-ABC1234"
    });
    const configured = (await (
      await withGtm.request("https://x.test/config")
    ).json()) as { gtmId: string | null };
    expect(configured.gtmId).toBe("GTM-ABC1234");
    const bare = (await (
      await app.request("https://x.test/config")
    ).json()) as { gtmId: string | null };
    expect(bare.gtmId).toBeNull();
  });

  it("serves the deployment's own publishable key when configured", async () => {
    const dogfood = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      publishableKey: "pk_own"
    });
    const configured = (await (
      await dogfood.request("https://x.test/config")
    ).json()) as { publishableKey: string | null };
    expect(configured.publishableKey).toBe("pk_own");
  });
});

describe("agent discovery routes", () => {
  it("keeps llms.txt doc links on the REQUEST origin, serve links on LV_SERVE_URL", async () => {
    // The hosted deployment sets a second campaign domain; that must
    // never swallow the documentation links (the bug this pins: every
    // llms.txt link once rendered against the serve domain).
    const twoDomain = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      serveUrl: "https://serve.example"
    });
    const txt = await (
      await twoDomain.request("https://main.example/llms.txt")
    ).text();
    expect(txt).toContain("https://main.example/skills/livevariant/SKILL.md");
    expect(txt).toContain("https://main.example/mcp");
    expect(txt).toContain("https://main.example/terms");
    expect(txt).toContain("https://serve.example/s?v=");
    expect(txt).toContain("https://serve.example/sdk.js");
    expect(txt).not.toContain("https://serve.example/mcp");
  });

  it("serves llms.txt and the skill, rendered for this origin", async () => {
    const res = await app.request("https://self.example/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("markdown");
    const txt = await res.text();
    expect(txt).toContain("/skills/livevariant/SKILL.md");
    const skill = await app.request(
      "https://self.example/skills/livevariant/SKILL.md"
    );
    expect(skill.status).toBe(200);
    const body = await skill.text();
    expect(body).toContain("# LiveVariant");
    expect(body).toContain("https://self.example/api/v1/");
  });
});

describe("the ESP template flow, end to end", () => {
  const HERO_A = "https://example.com/hero-warm";
  const HERO_B = "https://example.com/hero-cool";
  const CTA_A = "https://example.com/cta-go";
  const CTA_B = "https://example.com/cta-wait";
  const LANDING = "https://example.com/thanks";

  async function buildTemplate() {
    const res = await post(toolPath("build_test"), {
      slots: {
        hero: [
          { url: HERO_A, name: "warm" },
          { url: HERO_B, name: "cool" }
        ],
        cta: [
          { url: CTA_A, name: "go" },
          { url: CTA_B, name: "wait" }
        ]
      },
      context: [{ key: "source", from: "utm_source" }],
      redirectUrl: LANDING
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, any>;
  }

  const fill = (link: string, values: Record<string, string>) =>
    link.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, key: string) =>
      encodeURIComponent(values[key] ?? key)
    );

  it("serves both slots and rewards the click as ONE test", async () => {
    // The whole promise of the template: the links an ESP renders from
    // build_test's emailTemplate really serve, really share a sticky
    // combination, and the slot-less click really lands its conversion
    // on the same test. This drives the actual app, no mocks.
    const built = await buildTemplate();
    const values = {
      hero_variant_1_url: HERO_A,
      hero_variant_2_url: HERO_B,
      cta_variant_1_url: CTA_A,
      cta_variant_2_url: CTA_B,
      recipient_id: "reader-1"
    };
    const template = built.emailTemplate as Record<
      string,
      { imageSrc: string; linkHref: string }
    >;

    // Filled with the exact variants the test was built from, the
    // template spelling IS the built test, not a lookalike.
    const spelled = await configFromParams(
      new URL(fill(template.hero.imageSrc, values)).searchParams
    );
    expect(spelled.testId).toBe(built.testId);

    const hero = await app.request(fill(template.hero.imageSrc, values));
    expect(hero.status).toBe(302);
    expect(hero.headers.get("location")).toMatch(/hero-(warm|cool)/);
    const cta = await app.request(fill(template.cta.imageSrc, values));
    expect(cta.status).toBe(302);
    expect(cta.headers.get("location")).toMatch(/cta-(go|wait)/);

    // The click link carries no slot and still lands on the landing
    // page, rewarding the combination the images served.
    expect(template.hero.linkHref).toBe(template.cta.linkHref);
    const click = await app.request(fill(template.hero.linkHref, values), {
      headers: { accept: "text/html" }
    });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toContain(LANDING);

    const stats = (await (
      await app.request(`/stats/${built.config}`, {
        headers: { authorization: `Bearer ${built.statsSecret}` }
      })
    ).json()) as Record<string, any>;
    expect(stats.totalAssignments).toBe(1);
    const conversions = (stats.combinations as any[]).reduce(
      (sum, combo) => sum + combo.conversions,
      0
    );
    expect(conversions).toBe(1);
  });

  it("the next campaign's URLs mint a fresh test the same secret reads", async () => {
    const built = await buildTemplate();
    const nextCampaign = {
      hero_variant_1_url: "https://example.com/sept-warm",
      hero_variant_2_url: "https://example.com/sept-cool",
      cta_variant_1_url: CTA_A,
      cta_variant_2_url: CTA_B,
      recipient_id: "reader-2"
    };
    const template = built.emailTemplate as Record<
      string,
      { imageSrc: string; linkHref: string }
    >;
    const serve = await app.request(fill(template.hero.imageSrc, nextCampaign));
    expect(serve.status).toBe(302);
    expect(serve.headers.get("location")).toMatch(/sept-(warm|cool)/);

    // Different variant URLs, different identity: September is its own
    // test with its own empty history...
    const spelled = await configFromParams(
      new URL(fill(template.hero.imageSrc, nextCampaign)).searchParams
    );
    expect(spelled.testId).not.toBe(built.testId);

    // ...readable with the ORIGINAL stats secret, because the template
    // carries the same kh into every campaign it mints.
    const { encoded } = await encodeConfig(spelled.config);
    const stats = await app.request(`/stats/${encoded}`, {
      headers: { authorization: `Bearer ${built.statsSecret}` }
    });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as any).totalAssignments).toBe(1);
  });
});

describe("a Settings-minted stats key, end to end", () => {
  it("reads every template campaign built from a hand-held secret", async () => {
    // The Settings flow: a key generated (or invented) without the
    // builder, its kh wired into a hand-written template. Serving,
    // clicking and reading stats must all work from nothing but the
    // secret and its hash.
    const secret = "settings-minted-secret";
    const kh = await hashStatsSecret(secret);
    const spelled =
      `s=hero&v=${encodeURIComponent(A)}&vn=warm` +
      `&v=${encodeURIComponent(B)}&vn=cool` +
      `&s=cta&v=${encodeURIComponent(A)}&vn=go` +
      `&v=${encodeURIComponent(B)}&vn=wait` +
      `&r=${encodeURIComponent("https://example.com/lp")}&kh=${kh}`;

    const hero = await app.request(`/s?${spelled}&auto=0&id=r1&slot=hero`);
    expect(hero.status).toBe(302);
    const click = await app.request(`/c?${spelled}&auto=0&id=r1`, {
      headers: { accept: "text/html" }
    });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toContain("https://example.com/lp");

    const { config } = await configFromParams(
      new URLSearchParams(`${spelled}`)
    );
    const { encoded } = await encodeConfig(config);
    const stats = await app.request(`/stats/${encoded}`, {
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(stats.status).toBe(200);
    const body = (await stats.json()) as Record<string, any>;
    expect(body.totalAssignments).toBe(1);
    const conversions = (body.combinations as any[]).reduce(
      (sum, combo) => sum + combo.conversions,
      0
    );
    expect(conversions).toBe(1);
  });
});

describe("agent discovery well-knowns", () => {
  it("publishes an RFC 9727 API catalog for this origin", async () => {
    const res = await app.request(
      "https://self.example/.well-known/api-catalog"
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(
      "application/linkset+json"
    );
    const body = (await res.json()) as Record<string, any>;
    const entry = body.linkset[0];
    expect(entry.anchor).toBe("https://self.example/api/v1/");
    expect(entry["service-desc"][0].href).toBe(
      "https://self.example/openapi.json"
    );
    expect(entry["service-doc"][0].href).toBe("https://self.example/docs");
  });

  it("publishes an MCP server card naming the /mcp transport", async () => {
    for (const path of [
      "/.well-known/mcp/server-card.json",
      "/.well-known/mcp.json"
    ]) {
      const res = await app.request(`https://self.example${path}`);
      expect(res.status).toBe(200);
      const card = (await res.json()) as Record<string, any>;
      expect(card.serverInfo.name).toBe("livevariant");
      expect(card.transport).toEqual({
        type: "streamable-http",
        url: "https://self.example/mcp"
      });
      expect(card.documentation).toBe(
        "https://self.example/skills/livevariant/SKILL.md"
      );
      // Open deployment: the card says so.
      expect(card.authentication).toEqual({ type: "none" });
      expect(card.description).toContain("No authentication");
    }
  });

  it("the server card tells the truth about an LV_API_TOKEN gate", async () => {
    // A self-host gating /mcp must not advertise open access, or agents
    // following the card would send tokenless requests into 401s.
    const gated = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      apiToken: "operator-token"
    });
    const card = (await (
      await gated.request(
        "https://self.example/.well-known/mcp/server-card.json"
      )
    ).json()) as Record<string, any>;
    expect(card.authentication.type).toBe("bearer");
    expect(card.authentication.description).toContain("LV_API_TOKEN");
    expect(card.description).toContain("Bearer token");
    expect(card.description).not.toContain("No authentication");
  });

  it("indexes the skill with a digest of the exact served bytes", async () => {
    const res = await app.request(
      "https://self.example/.well-known/agent-skills/index.json"
    );
    expect(res.status).toBe(200);
    const index = (await res.json()) as Record<string, any>;
    expect(index.$schema).toContain("agentskills.io");
    const [skill] = index.skills;
    expect(skill.name).toBe("livevariant");
    expect(skill.type).toBe("skill-md");
    expect(skill.url).toBe("/skills/livevariant/SKILL.md");
    // The digest must be the hash of what the URL actually serves, so
    // an agent verifying the download always agrees.
    const served = await (
      await app.request("https://self.example/skills/livevariant/SKILL.md")
    ).text();
    expect(skill.digest).toBe(`sha256:${await sha256Hex(served)}`);
  });

  it("serves auth.md as markdown telling the truth: nothing to register", async () => {
    const res = await app.request("https://self.example/auth.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    // Consumers identify the document by its H1, so it must name the
    // convention rather than just the service.
    expect(text).toMatch(/^# Auth\.md/i);
    expect(text).toContain("NO registration");
    expect(text).toContain("https://self.example/api/v1/");
    // No aspirational OAuth: the honest story is the whole story.
    expect(text).not.toContain("authorization_endpoint");
  });

  it("welcomes crawlers, training included, but not the serving paths", async () => {
    const res = await app.request("https://self.example/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const txt = await res.text();
    // Not HTML: without this route the SPA fallback answered /robots.txt
    // with index.html, which a crawler cannot use at all.
    expect(txt).not.toContain("<!doctype html>");
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
    // Training is welcome on purpose: a model that knows LiveVariant
    // exists is this product's distribution.
    expect(txt).toContain("ai-train=yes");
    expect(txt).not.toContain("ai-train=no");
    // The serving endpoints mutate live tests, so they stay out...
    for (const path of ["/s/", "/c/", "/px/", "/a/"]) {
      expect(txt).toContain(`Disallow: ${path}`);
    }
    // ...but the prefixes an agent actually needs must NOT be caught by
    // those rules (a bare "Disallow: /s" would have blocked both).
    expect(txt).not.toMatch(/Disallow: \/s$/m);
    expect(txt).not.toMatch(/Disallow: \/skills/);
    expect(txt).not.toMatch(/Disallow: \/sitemap/);
    expect(txt).toContain("Sitemap: https://self.example/sitemap.xml");
  });

  it("serves a sitemap of the public pages", async () => {
    const res = await app.request("https://self.example/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("xml");
    const xml = await res.text();
    expect(xml).toContain("<loc>https://self.example/</loc>");
    expect(xml).toContain("<loc>https://self.example/builder</loc>");
    expect(xml).not.toContain("/settings");
  });

  it("negotiates the homepage: markdown for agents, the shell for browsers", async () => {
    const withShell = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      spaFetch: async () =>
        new Response("<html>shell</html>", {
          headers: { "content-type": "text/html" }
        })
    });
    const markdown = await withShell.request("https://self.example/", {
      headers: { accept: "text/markdown" }
    });
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toContain("# LiveVariant");

    const html = await withShell.request("https://self.example/", {
      headers: { accept: "text/html" }
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("shell");
    // RFC 8288 discovery on the HTML response too.
    expect(html.headers.get("link")).toContain(
      '</.well-known/api-catalog>; rel="api-catalog"'
    );
    expect(markdown.headers.get("link")).toContain("api-catalog");
  });
});
