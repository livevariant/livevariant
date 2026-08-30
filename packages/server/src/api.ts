import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "@livevariant/mcp";
import {
  geoFromRequest,
  regionHint,
  sha256Hex,
  type RequestGeo
} from "@livevariant/core";
import { SERVER_VERSION } from "./version.js";
import {
  renderAuthMd,
  renderLlmsTxt,
  renderRobotsTxt,
  renderSkillMd,
  SKILL_DESCRIPTION
} from "@livevariant/tools";
import type { AccountsProvider } from "./accounts-port.js";
import {
  TOOLS,
  ToolInputError,
  buildOpenApiDocument,
  swaggerPage,
  toolPath,
  type ToolContext,
  type ToolDefinition
} from "@livevariant/tools";

/**
 * The REST face of the same tool registry the MCP server exposes. It
 * exists because an agent handed our SKILL cannot always install an MCP
 * server, and then plain HTTP is the only way in. Both surfaces call the
 * identical handler, so they cannot answer the same question differently.
 *
 * The document at /openapi.json is generated from those definitions too,
 * which is what stops the docs describing an API we do not serve.
 *
 * /mcp is the same registry a third time, over the protocol itself, so a
 * client that speaks MCP needs nothing installed locally. It is stateless
 * by construction: every tool is a pure function of its arguments, so
 * there is no session worth keeping and a fresh server per request costs
 * nothing while removing every question about session affinity across
 * Worker isolates.
 */

export interface ApiOptions {
  /**
   * Origin to put in the links visitors follow. Unset means "wherever this
   * request arrived", which is what lets a one-domain self-host work with
   * no configuration at all; set it only when serving has its own domain.
   */
  serveUrl?: string;
  /**
   * Dispatches the tools' own HTTP calls. The host passes one that routes
   * back into this app in-process: a Worker cannot fetch its own hostname,
   * and even where it can, a round trip to yourself is pure latency.
   */
  fetch: typeof globalThis.fetch;
  /**
   * When set, the tool API and /mcp require `Authorization: Bearer` with
   * exactly this value: the self-hoster's server-to-server credential
   * (LV_API_TOKEN), one deployment-wide identity meaning "the operator".
   * Unset keeps both surfaces open, which is the account-free default.
   * The hosted deployment must never set it: "operator" is the wrong
   * granularity for a multi-tenant service.
   */
  apiToken?: string;
  /**
   * Runtime-only credential for deployments that gate POST /assets with
   * LV_ASSET_UPLOAD_TOKEN. HTTP MCP may receive it only behind the
   * LV_API_TOKEN gate; open MCP callers must not inherit write authority.
   */
  assetUploadToken?: string;
  /**
   * The accounts read side. Its presence is what registers the
   * account-scoped tools (list_tests); a deployment without it never
   * shows an agent a tool it cannot serve.
   */
  provider?: AccountsProvider;
  /**
   * Google Tag Manager container id (GTM-XXXXXXX) for the DASHBOARD
   * pages themselves (LV_GOOGLE_TAG_MANAGER). Served through /config;
   * the SPA injects the container when present. Unset means no GTM,
   * which is the default and the self-host norm.
   */
  gtmId?: string;
  /**
   * The deployment's OWN publishable key (LV_PUBLISHABLE_KEY), for
   * dogfooding: the dashboard's landing page runs a real test, and this
   * is the key it registers under. Served through /config; unset means
   * the landing waits briefly for a tag-set global instead.
   */
  publishableKey?: string;
  /**
   * OpenAI Apps domain-verification token, served from
   * /.well-known/openai-apps-challenge when configured by the hosted entry.
   */
  openaiAppsChallengeToken?: string;
  /**
   * Fetches the static app shell, for the homepage route that runs
   * worker-first to offer agents markdown negotiation and Link headers
   * while browsers still get the SPA. On Workers this is the ASSETS
   * binding; absent (tests, hosts without an asset store) the homepage
   * 404s rather than pretending to have a shell.
   */
  spaFetch?: (request: Request) => Promise<Response>;
  /**
   * Path prefix this app is mounted under. See AppOptions.basePath: every
   * origin computed from a request URL below has to carry it, or the
   * links and the discovery documents point at a root this deployment
   * does not own.
   */
  basePath?: string;
  /** Where a request's geography comes from. See AppOptions.geo. */
  geo?: (request: Request) => RequestGeo | null;
}

export function createApi(options: ApiOptions): Hono {
  const app = new Hono();
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  const resolveGeo = options.geo ?? geoFromRequest;
  /**
   * This deployment's own base: the origin the request arrived on plus
   * whatever prefix it is mounted under. Every self-referential URL here
   * goes through it, so a mounted deployment describes itself correctly
   * instead of pointing at the root of a host it shares.
   */
  const baseOf = (url: string): string => new URL(url).origin + basePath;

  /**
   * Built per request, so every generated URL points at whatever origin
   * the caller actually reached. That is what makes the single-domain
   * deployment need no configuration.
   */
  // Blank counts as unset. The deploy button offers LV_SERVE_URL with an
  // empty default and tells people to leave it alone unless they run a
  // second domain, so an empty string is the expected input, not a typo.
  // Passed through, it built origin-less URLs like "/s/<config>", which in
  // an email resolve against the mail client and serve nothing.
  const serveUrl = options.serveUrl?.trim() || undefined;
  const provider = options.provider;
  const apiToken = options.apiToken?.trim() || undefined;
  const assetUploadToken = options.assetUploadToken?.trim() || undefined;
  const contextFor = (
    url: string,
    raw?: Request,
    contextOptions?: { assetUploader?: boolean }
  ): ToolContext => {
    const origin = baseOf(url);
    // The caller's own geography, so build_test can default a new
    // test's region to its CREATOR's location rather than to wherever
    // the first serve later comes from (in email: a mail proxy).
    const geo = raw ? resolveGeo(raw) : null;
    return {
      serverUrl: origin,
      serveUrl: serveUrl ?? origin,
      region: regionHint(geo) ?? undefined,
      assetUploadToken: contextOptions?.assetUploader
        ? assetUploadToken
        : undefined,
      fetch: options.fetch,
      // Identity resolves lazily per call: a session cookie on the
      // same-origin dashboard identifies the caller; without one the
      // tool rejects with instructions instead of listing nothing.
      accounts:
        provider && raw
          ? {
              registerWithSecret: provider.registerWithSecret
                ? input => provider.registerWithSecret!(input)
                : undefined,
              testStatus: provider.testStatusWithSecret
                ? input => provider.testStatusWithSecret!(input)
                : undefined,
              listTests: async listOptions => {
                const orgIds = await provider.sessionOrgIds(raw);
                if (orgIds.length === 0) {
                  throw new ToolInputError(
                    "sign in required: call this from a signed-in " +
                      "dashboard session",
                    401
                  );
                }
                return provider.listTests(orgIds, listOptions);
              }
            }
          : undefined
    };
  };

  // Open CORS, for the same reason the serving endpoints are: there are no
  // cookies anywhere, and a stats secret in the body authorizes itself, so
  // the origin proves nothing worth checking.
  const openCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "mcp-session-id", "mcp-protocol-version"],
    exposeHeaders: ["mcp-session-id"]
  });
  app.use("/api/*", openCors);
  app.use("/mcp", openCors);

  if (apiToken) {
    const gate = async (
      c: Parameters<Parameters<Hono["use"]>[1]>[0],
      next: () => Promise<void>
    ): Promise<Response | undefined> => {
      const header = c.req.header("authorization");
      const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
      // Hash both sides before comparing: constant-time by construction.
      if (!token || (await sha256Hex(token)) !== (await sha256Hex(apiToken))) {
        return c.json({ error: "api token required" }, 401);
      }
      await next();
      return undefined;
    };
    // Discovery stays open (/config, /openapi.json, /docs describe the
    // API without granting anything); the tools and MCP need the token.
    app.use("/api/v1/*", gate);
    app.use("/mcp", gate);
  }

  const availableTools = (TOOLS as readonly ToolDefinition[]).filter(
    tool => tool.scope !== "account" || provider !== undefined
  );
  for (const tool of availableTools) {
    // Tool names are spelled with underscores (build_test) but the
    // canonical REST path hyphenates them (/api/v1/build-test). The docs
    // invite substituting a tool's name into the path template, so the
    // literal substitution must work too: mount every tool on both
    // spellings rather than letting the honest reading of the docs 404.
    const paths = new Set([toolPath(tool.name), `/api/v1/${tool.name}`]);
    for (const path of paths) {
      app.post(path, async c => {
        const body: unknown = await c.req.json().catch(() => undefined);
        const parsed = tool.input.safeParse(body ?? {});
        if (!parsed.success) {
          return c.json(
            { error: "invalid request", details: parsed.error.issues },
            400
          );
        }
        try {
          return c.json(
            await tool.handler(parsed.data, contextFor(c.req.url, c.req.raw))
          );
        } catch (err) {
          if (err instanceof ToolInputError) {
            return c.json({ error: err.message }, err.status);
          }
          throw err;
        }
      });
    }
  }

  // The dashboard is a static build, so it cannot read the deployment's
  // configuration at compile time. It asks here instead, which is what
  // makes the builder default to livevariant.link on the hosted service
  // and to a self-hoster's own origin on theirs, with nothing baked in.
  app.get("/config", c =>
    c.json({
      serveUrl: serveUrl ?? baseOf(c.req.url),
      // The dashboard defaults a new test's region to its creator's.
      region: regionHint(resolveGeo(c.req.raw)),
      gtmId: options.gtmId?.trim() || null,
      publishableKey: options.publishableKey?.trim() || null,
      server: SERVER_VERSION
    })
  );

  // Agent discovery: the same single-source docs the skill and MCP
  // serve, rendered with THIS deployment's origin so a self-host
  // describes itself. Markdown, because the readers are LLMs. Doc,
  // MCP and legal links belong to the origin the request arrived on;
  // only campaign-carried links (/s example, sdk.js) use the serve
  // domain when one is configured.
  app.get("/llms.txt", c =>
    c.text(renderLlmsTxt(baseOf(c.req.url), serveUrl), 200, {
      "content-type": "text/markdown; charset=utf-8"
    })
  );
  app.get("/skills/livevariant/SKILL.md", c =>
    c.text(renderSkillMd(baseOf(c.req.url)), 200, {
      "content-type": "text/markdown; charset=utf-8"
    })
  );

  app.get("/openapi.json", c =>
    c.json(buildOpenApiDocument({ serverUrl: baseOf(c.req.url) }))
  );
  app.get("/docs", c => c.html(swaggerPage("/openapi.json")));

  /* ------------------------------------------------------------------ */
  // Agent discovery well-knowns. Everything renders against the request
  // origin so a self-host describes itself, and everything advertised
  // actually exists on this deployment. Deliberately absent: OAuth/OIDC
  // discovery metadata, because these APIs are open by design and
  // advertising an authorization server nobody runs would send agents
  // hunting for a flow that does not exist (/auth.md says so instead).

  // RFC 9727: the API catalog, pointing at the OpenAPI document, the
  // interactive docs and the health endpoint.
  app.get("/.well-known/api-catalog", c => {
    const base = baseOf(c.req.url);
    return c.body(
      JSON.stringify({
        linkset: [
          {
            anchor: `${base}/api/v1/`,
            "service-desc": [
              { href: `${base}/openapi.json`, type: "application/json" }
            ],
            "service-doc": [{ href: `${base}/docs`, type: "text/html" }],
            status: [{ href: `${base}/health` }],
            describedby: [{ href: `${base}/llms.txt`, type: "text/markdown" }]
          }
        ]
      }),
      200,
      { "content-type": "application/linkset+json" }
    );
  });

  // MCP Server Card (SEP-1649): what /mcp is, without connecting first.
  // The authentication block reflects THIS deployment: a self-host that
  // gates the endpoint with LV_API_TOKEN must not advertise open access,
  // or agents following the card would send tokenless requests into 401s.
  const mcpServerCard = (c: { req: { url: string } }) => {
    const base = baseOf(c.req.url);
    return {
      serverInfo: { name: "livevariant", version: SERVER_VERSION },
      description:
        "Adaptive A/B testing tools: build tests that live in URLs, " +
        "inspect links, warm-start with priors, and read results with " +
        "win probabilities. " +
        (apiToken
          ? "This deployment requires a Bearer token on /mcp (its " +
            "operator's LV_API_TOKEN); within that, tests are scoped by " +
            "their config and stats secret."
          : "Creating tests needs no account; result reads require the " +
            "test's stats secret."),
      transport: { type: "streamable-http", url: `${base}/mcp` },
      authentication: apiToken
        ? {
            type: "bearer",
            description:
              "Authorization: Bearer <token>; ask this deployment's " +
              "operator for its LV_API_TOKEN."
          }
        : { type: "none" },
      capabilities: { tools: {}, resources: {} },
      documentation: `${base}/skills/livevariant/SKILL.md`
    };
  };
  app.get("/.well-known/mcp/server-card.json", c => c.json(mcpServerCard(c)));
  app.get("/.well-known/mcp.json", c => c.json(mcpServerCard(c)));

  // Agent Skills Discovery (v0.2.0). The digest is computed live from
  // the exact document /skills/livevariant/SKILL.md serves for this
  // origin, so it can never drift from the content.
  app.get("/.well-known/agent-skills/index.json", async c => {
    const base = baseOf(c.req.url);
    const digest = await sha256Hex(renderSkillMd(base));
    return c.json({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "livevariant",
          type: "skill-md",
          description: SKILL_DESCRIPTION,
          url: "/skills/livevariant/SKILL.md",
          digest: `sha256:${digest}`
        }
      ]
    });
  });

  const openaiAppsChallengeToken =
    options.openaiAppsChallengeToken?.trim() || undefined;
  if (openaiAppsChallengeToken) {
    app.get("/.well-known/openai-apps-challenge", c =>
      c.text(openaiAppsChallengeToken, 200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      })
    );
  }

  // auth.md (workos.com/auth-md): the honest registration story.
  app.get("/auth.md", c =>
    c.text(renderAuthMd(baseOf(c.req.url)), 200, {
      "content-type": "text/markdown; charset=utf-8"
    })
  );

  // Crawling is welcome, training included: see renderRobotsTxt. Served
  // by the worker rather than shipped as a static file so the Sitemap
  // directive names the origin the request arrived on.
  app.get("/robots.txt", c =>
    c.text(renderRobotsTxt(baseOf(c.req.url)), 200, {
      "content-type": "text/plain; charset=utf-8"
    })
  );

  // The dashboard's public pages; app routes behind sign-in stay out.
  app.get("/sitemap.xml", c => {
    const base = baseOf(c.req.url);
    const pages = ["/", "/builder", "/terms", "/privacy"];
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      pages.map(page => `  <url><loc>${base}${page}</loc></url>`).join("\n") +
      `\n</urlset>\n`;
    return c.body(xml, 200, {
      "content-type": "application/xml; charset=utf-8"
    });
  });

  // The homepage, worker-first for two agent affordances: markdown
  // negotiation (Accept: text/markdown answers with the same document
  // as /llms.txt) and RFC 8288 Link headers on the HTML. Browsers get
  // the SPA shell from the host-injected asset fetcher, untouched
  // except for the added Link header.
  const AGENT_LINKS =
    '</.well-known/api-catalog>; rel="api-catalog", ' +
    '</openapi.json>; rel="service-desc", ' +
    '</docs>; rel="service-doc", ' +
    '</llms.txt>; rel="describedby"';
  app.get("/", async c => {
    if ((c.req.header("accept") ?? "").includes("text/markdown")) {
      return c.text(renderLlmsTxt(baseOf(c.req.url), serveUrl), 200, {
        "content-type": "text/markdown; charset=utf-8",
        link: AGENT_LINKS
      });
    }
    if (!options.spaFetch) {
      return c.notFound();
    }
    const shell = await options.spaFetch(c.req.raw);
    const page = new Response(shell.body, shell);
    page.headers.append("link", AGENT_LINKS);
    return page;
  });

  // MCP over HTTP. No authentication, for the same reason the rest of this
  // has none: a test is its config, and reading results needs the stats
  // secret checked against the hash inside that config, so authority
  // travels in the arguments and there is nothing to log in to.
  app.all("/mcp", async c => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON rather than an SSE stream: nothing here ever pushes a
      // server-initiated message, and a Worker billed for wall-clock has
      // no reason to hold a stream open for a request/response exchange.
      enableJsonResponse: true
    });
    const server = createServer(
      contextFor(c.req.url, c.req.raw, {
        assetUploader: apiToken !== undefined
      })
    );
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // A per-request server holds no state worth keeping, and leaving it
      // connected would leak a transport per call.
      await server.close();
    }
  });

  return app;
}
