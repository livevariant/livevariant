import { describe, expect, it } from "vitest";
import { decodeConfig, hashStatsSecret } from "@livevariant/core";
import {
  TOOLS,
  buildTest,
  uploadImage,
  findTool,
  generatePriors,
  getStats,
  getTestStatus,
  inspectTest,
  variantBrief
} from "./tools.js";
import { ToolInputError, toolPath } from "./types.js";

const A = "https://cdn.example.com/hero-a.jpg";
const B = "https://cdn.example.com/hero-b.jpg";

/** No tool may reach the real network in a test. */
const noFetch: typeof globalThis.fetch = () => {
  throw new Error("unexpected network call");
};
const ctx = { serverUrl: "https://livevariant.link", fetch: noFetch };

async function twoVariantTest() {
  return buildTest.handler({ variants: [{ url: A }, { url: B }] }, ctx);
}

async function segmentedTest() {
  return buildTest.handler(
    {
      variants: [{ url: A }, { url: B }],
      context: [{ key: "color", values: ["blauw", "rood"] }]
    },
    ctx
  );
}

describe("the registry itself", () => {
  it("has unique names and a REST path for each", () => {
    const names = TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(n => /^[a-z][a-z0-9_]*$/.test(n))).toBe(true);
    expect(toolPath("get_stats")).toBe("/api/v1/get-stats");
  });

  it("describes every tool well enough to choose between them", () => {
    // These strings are the entire basis on which an assistant picks a
    // tool, and they are also what the SKILL table renders.
    for (const tool of TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.summary.length).toBeGreaterThan(20);
      expect(tool.description.length).toBeGreaterThan(80);
      expect(findTool(tool.name)).toBe(tool);
    }
  });

  it("only reaches the network where it must", () => {
    expect(getStats.reachesNetwork).toBe(true);
    expect(uploadImage.reachesNetwork).toBe(true);
    // Non-read-only tools: build_test may register a test when given a
    // publishable key, upload_image stores bytes, and register_test writes
    // an ownership record.
    expect(buildTest.reachesNetwork).toBe(false);
    expect(buildTest.readOnly).toBe(false);
    expect(uploadImage.readOnly).toBe(false);
    const registerTest = TOOLS.find(t => t.name === "register_test")!;
    expect(registerTest.reachesNetwork).toBe(true);
    expect(registerTest.readOnly).toBe(false);
    // get_test_status reads the registry over the network but writes
    // nothing.
    const getTestStatus = TOOLS.find(t => t.name === "get_test_status")!;
    expect(getTestStatus.reachesNetwork).toBe(true);
    expect(getTestStatus.readOnly).toBe(true);
    const writers = new Set([
      "build_test",
      "get_stats",
      "get_test_status",
      "upload_image",
      "register_test"
    ]);
    for (const tool of TOOLS.filter(t => !writers.has(t.name))) {
      expect(tool.reachesNetwork).toBe(false);
      expect(tool.readOnly).toBe(true);
    }
  });
});

describe("build_test", () => {
  it("returns a working test with every URL and the secret once", async () => {
    const out = await buildTest.handler(
      { variants: [{ url: A, name: "hero" }, { url: B }], name: "August" },
      ctx
    );
    expect(out.testId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.urls.serve).toBe(`https://livevariant.link/s/${out.config}`);
    expect(out.urls.manage).toContain(`#${out.statsSecret}`);
    expect(out.urls.serveNoAutoContext).toContain("auto=0");

    // The config really is the test: it decodes, and only the HASH of the
    // secret is in it, so the secret cannot be recovered from a URL.
    const decoded = await decodeConfig(out.config);
    expect(decoded.testId).toBe(out.testId);
    expect(decoded.config.slots.main.map(v => v.name)).toEqual(["hero", "v2"]);
    expect(decoded.config.statsKeyHash).toBe(
      await hashStatsSecret(out.statsSecret)
    );
    expect(out.config).not.toContain(out.statsSecret);
  });

  it("builds a multi-slot test that optimizes the combination", async () => {
    const out = await buildTest.handler(
      {
        slots: {
          hero: [
            { url: A, name: "warm" },
            { url: B, name: "cool" }
          ],
          cta: [
            { url: "https://example.com/go", name: "go" },
            { url: "https://example.com/wait", name: "wait" }
          ]
        }
      },
      ctx
    );
    expect(out.combinations).toBe(4);
    // Canonical (sorted) slot order, same as stats will report.
    expect(out.slots.map(s => s.slot)).toEqual(["cta", "hero"]);
    // One template per slot, each naming which element it serves.
    expect(out.emailTemplate.hero.imageSrc).toContain("slot=hero");
    expect(out.emailTemplate.cta.imageSrc).toContain("slot=cta");
    expect(out.emailTemplate.hero.imageSrc).toContain("s=hero");
    // Hypothesis names ride along, so every campaign's stats keep them.
    expect(out.emailTemplate.hero.imageSrc).toContain("vn=warm");
    // ONE slot-less click link shared by every element: the template's
    // destination never depends on which image was clicked.
    expect(out.emailTemplate.hero.linkHref).not.toContain("slot=");
    expect(out.emailTemplate.hero.linkHref).toBe(
      out.emailTemplate.cta.linkHref
    );
    // The bare serve URL 400s for multi-slot tests, so ready per-slot
    // links must be part of the answer.
    expect(out.slotLinks).toEqual({
      hero: {
        serve: `${out.urls.serve}?slot=hero`,
        click: `${out.urls.click}?slot=hero`
      },
      cta: {
        serve: `${out.urls.serve}?slot=cta`,
        click: `${out.urls.click}?slot=cta`
      }
    });
  });

  it("keeps slotLinks absent for single-element tests", async () => {
    const out = await twoVariantTest();
    expect(out.slotLinks).toBeUndefined();
  });

  it("reports destination verification and warns on unverified hosts", async () => {
    const statusCalls: Array<{ encoded: string; statsSecret: string }> = [];
    const out = await buildTest.handler(
      { variants: [{ url: A }, { url: B }] },
      {
        ...ctx,
        accounts: {
          listTests: () => Promise.reject(new Error("not needed")),
          testStatus: async input => {
            statusCalls.push(input);
            return {
              ok: true as const,
              testId: "x".repeat(64),
              claimed: false,
              org: null,
              destinations: [{ host: "cdn.example.com", verified: false }]
            };
          }
        }
      }
    );
    // Status was asked with the freshly minted pair, never a lookalike.
    expect(statusCalls).toEqual([
      { encoded: out.config, statsSecret: out.statsSecret }
    ]);
    expect(out.destinations).toEqual([
      { host: "cdn.example.com", verified: false }
    ]);
    expect(
      out.warnings.some(
        w => w.includes("cdn.example.com") && w.includes("continue screen")
      )
    ).toBe(true);
  });

  it("refuses both spellings at once, and neither", async () => {
    await expect(
      buildTest.handler(
        { variants: [{ url: A }, { url: B }], slots: { x: [{ url: A }] } },
        ctx
      )
    ).rejects.toThrow();
    await expect(buildTest.handler({}, ctx)).rejects.toThrow();
  });

  it("warns when a variant cannot be served by redirect", async () => {
    // The trap: mixing inline and redirect variants makes the serve URL
    // 400 for EVERYONE, not just for that variant.
    const out = await buildTest.handler(
      { variants: [{ url: A }, { text: "Buy now" }] },
      ctx
    );
    expect(out.warnings.join(" ")).toMatch(/cannot be served by redirect/i);
  });

  it("builds an ESP template from one shared config string", async () => {
    const out = await twoVariantTest();
    const { imageSrc, linkHref } = out.emailTemplate.main;
    expect(imageSrc).toContain("v={{variant_1_url}}");
    expect(imageSrc).toContain("v={{variant_2_url}}");
    expect(imageSrc).toMatch(/kh=[0-9a-f]{64}/);
    // Email defaults to no derived context, which is the honest setting.
    expect(imageSrc).toContain("auto=0");
    // r is identity: it must ride on the image link too, or the click
    // would reward a different test than the one being served.
    expect(imageSrc).toContain("r={{landing_url}}");
    expect(linkHref).toContain("r={{landing_url}}");
    const configOf = (link: string) =>
      new URL(link.replace(/\{\{/g, "X").replace(/\}\}/g, "Y")).search
        .replace(/&(auto|id|slot)=[^&]*/g, "")
        .replace(/\?(auto|id|slot)=[^&]*&?/, "?");
    expect(configOf(linkHref)).toBe(configOf(imageSrc));
  });
});

describe("inspect_test", () => {
  it("accepts a bare config, a serve URL and a manage URL alike", async () => {
    const built = await twoVariantTest();
    for (const ref of [
      built.config,
      built.urls.serve,
      `${built.urls.serve}?id=abc`,
      built.urls.manage
    ]) {
      const out = await inspectTest.handler({ test: ref }, ctx);
      expect(out.testId).toBe(built.testId);
    }
  });

  it("reads the query-parameter spelling too", async () => {
    const out = await inspectTest.handler(
      { test: `https://livevariant.link/s?v=${A}&v=${B}&id=x` },
      ctx
    );
    expect(out.slots[0].variants).toHaveLength(2);
    expect(out.resultsReadable).toBe(false);
  });

  it("flags a test whose results nobody will ever be able to read", async () => {
    const out = await inspectTest.handler(
      { test: `https://livevariant.link/s?v=${A}&v=${B}` },
      ctx
    );
    expect(
      out.findings.some(
        f => f.level === "error" && /never be read/.test(f.message)
      )
    ).toBe(true);
  });

  it("notes that geo context is suppressed for email proxies", async () => {
    const built = await buildTest.handler(
      {
        variants: [{ url: A }, { url: B }],
        context: [{ key: "country", from: "country" }]
      },
      ctx
    );
    const out = await inspectTest.handler({ test: built.config }, ctx);
    expect(out.findings.some(f => /mail provider/i.test(f.message))).toBe(true);
  });

  it("refuses nonsense with a message a person can act on", async () => {
    await expect(
      inspectTest.handler({ test: "not-a-test" }, ctx)
    ).rejects.toThrow(ToolInputError);
    await expect(
      inspectTest.handler({ test: "https://livevariant.link/s" }, ctx)
    ).rejects.toThrow(/carries no LiveVariant test/);
  });
});

describe("generate_priors", () => {
  it("keeps the test's identity, which is what makes it safe mid-flight", async () => {
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: "v2", rate: 0.08 }],
        confidence: "medium"
      },
      ctx
    );
    // Priors are excluded from the identity hash on purpose: a live test
    // must keep its id and its whole event history.
    expect(out.testId).toBe(built.testId);
    expect(out.config).not.toBe(built.config);
    expect(out.manageUrl).toBe(`https://livevariant.link/manage/${out.config}`);
    const decoded = await decodeConfig(out.config);
    expect(decoded.config.priors?.main).toHaveLength(2);
  });

  it("keeps a belief about one segment off everybody else's variant", async () => {
    // The distinction the feature exists for: "B is the one for blue" is
    // not "B is the one", and writing it as the latter would steer every
    // other segment on evidence that was never about them.
    const built = await segmentedTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        when: { color: "blauw" },
        beliefs: [{ variant: "v2", rate: 0.08 }],
        confidence: "medium"
      },
      ctx
    );
    expect(out.testId).toBe(built.testId);
    const decoded = await decodeConfig(out.config);
    expect(decoded.config.priors).toBeUndefined();
    expect(decoded.config.ctxPriors).toHaveLength(1);
    expect(decoded.config.ctxPriors?.[0].when).toEqual({ color: "blauw" });

    // A second segment adds a block; the same segment replaces its own.
    const second = await generatePriors.handler(
      {
        test: out.config,
        when: { color: "rood" },
        beliefs: [{ variant: "v1", rate: 0.09 }],
        confidence: "medium"
      },
      ctx
    );
    const redone = await generatePriors.handler(
      {
        test: second.config,
        when: { color: "blauw" },
        beliefs: [{ variant: "v1", rate: 0.02 }],
        confidence: "medium"
      },
      ctx
    );
    const final = await decodeConfig(redone.config);
    expect(final.config.ctxPriors).toHaveLength(2);
    expect(final.config.ctxPriors?.map(b => b.when.color).sort()).toEqual([
      "blauw",
      "rood"
    ]);
  });

  it("refuses a segment the test does not have", async () => {
    const built = await segmentedTest();
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          when: { color: "paars" },
          beliefs: [{ variant: 0, rate: 0.05 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/not a value of "color"/);
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          when: { device: "mobile" },
          beliefs: [{ variant: 0, rate: 0.05 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/no context dimension "device"/);
  });

  it("turns a rate and a confidence into a capped prior that washes out", async () => {
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: 1, rate: 0.1 }],
        confidence: "high"
      },
      ctx
    );
    expect(out.priors).toEqual([
      { slot: "main", variant: "v2", mean: 0.1, strength: 30 }
    ]);
    expect(out.washesOutAfter).toBe(30);
  });

  it("refuses to encode certainty", async () => {
    // A prior of exactly 0 or 1 cannot be moved by any evidence, which is
    // never what someone means by "I'm sure".
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: 0, rate: 1 }],
        confidence: "low"
      },
      ctx
    );
    expect(out.priors[0].mean).toBeLessThan(1);
    expect(out.notes.join(" ")).toMatch(/certainty/i);
  });

  it("leaves unrated variants alone and says so", async () => {
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: 0, rate: 0.05 }],
        confidence: "low"
      },
      ctx
    );
    // Only rated variants get a prior at all; the rest are named in notes.
    expect(out.priors.map(p => p.variant)).toEqual(["v1"]);
    expect(out.notes.join(" ")).toMatch(/without a prior/i);
  });

  it("demands a slot name on multi-slot tests", async () => {
    const built = await buildTest.handler(
      {
        slots: {
          hero: [{ url: A }, { url: B }],
          cta: [{ url: A }, { url: B }]
        }
      },
      ctx
    );
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          beliefs: [{ variant: 0, rate: 0.1 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/which slot/);
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ slot: "hero", variant: 1, rate: 0.1 }],
        confidence: "low"
      },
      ctx
    );
    expect(out.testId).toBe(built.testId);
    expect(out.priors).toEqual([
      { slot: "hero", variant: "v2", mean: 0.1, strength: 5 }
    ]);
  });

  it("names the variants it does not recognize", async () => {
    const built = await twoVariantTest();
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          beliefs: [{ variant: "nope", rate: 0.1 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/no variant called "nope"/);
  });
});

describe("get_stats", () => {
  const statsBody = {
    testId: "a".repeat(64),
    totalAssignments: 2000,
    combinations: [
      {
        cell: 0,
        choice: ["control"],
        pulls: 1000,
        conversions: 50,
        rewardTotal: 50,
        conversionRate: 0.05
      },
      {
        cell: 1,
        choice: ["variant"],
        pulls: 1000,
        conversions: 90,
        rewardTotal: 90,
        conversionRate: 0.09
      }
    ],
    slots: {
      main: [
        { name: "control", pulls: 1000, conversions: 50, conversionRate: 0.05 },
        { name: "variant", pulls: 1000, conversions: 90, conversionRate: 0.09 }
      ]
    },
    buckets: {},
    bySignal: { country: { nl: { pulls: 1200, conversions: 80 } } },
    excluded: { total: 0, bySource: 0, byWindow: 0 }
  };

  function fakeFetch(status = 200, body: unknown = statsBody) {
    const calls: Array<{ url: string; auth?: string }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)
          ?.authorization
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof globalThis.fetch;
    return { calls, impl };
  }

  it("computes the win probability rather than leaving it to be guessed", async () => {
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    const out = await getStats.handler(
      { test: built.config, statsSecret: built.statsSecret },
      { ...ctx, fetch: impl }
    );
    expect(calls[0].auth).toBe(`Bearer ${built.statsSecret}`);
    expect(out.combinations[1].probabilityBest).toBeGreaterThan(0.99);
    expect(out.decision.leader).toBe("variant");
    expect(out.decision.canStop).toBe(true);
    expect(out.decision.advice).toMatch(/winner/i);
  });

  it("takes the secret from a manage URL's fragment", async () => {
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    await getStats.handler(
      { test: built.urls.manage },
      { ...ctx, fetch: impl }
    );
    expect(calls[0].auth).toBe(`Bearer ${built.statsSecret}`);
  });

  it("never sends the secret to an origin the pasted URL chose", async () => {
    // The attack this pins: `test` arrives from a document, an email or an
    // injected instruction, while the secret can come from trusted context
    // earlier in the conversation. Honouring the URL's own origin would
    // hand that secret to whoever wrote the link.
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    await expect(
      getStats.handler(
        {
          test: `https://attacker.example/manage/${built.config}`,
          statsSecret: built.statsSecret
        },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/only ever sent to the configured server/);
    expect(calls).toHaveLength(0);
  });

  it("refuses even when the hostile URL carries its own fragment secret", async () => {
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    await expect(
      getStats.handler(
        {
          test: `https://attacker.example/manage/${built.config}#${built.statsSecret}`
        },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/do not trust the link/);
    expect(calls).toHaveLength(0);
  });

  it("still works for a self-hoster whose client is configured to match", async () => {
    const built = await buildTest.handler(
      { variants: [{ url: A }, { url: B }], serverUrl: "https://ab.internal" },
      ctx
    );
    const { impl, calls } = fakeFetch();
    await getStats.handler(
      { test: built.urls.manage },
      { serverUrl: "https://ab.internal", fetch: impl }
    );
    expect(calls[0].url).toContain("https://ab.internal/stats/");
  });

  it("says plainly when there is no secret to use", async () => {
    const built = await twoVariantTest();
    await expect(getStats.handler({ test: built.config }, ctx)).rejects.toThrow(
      /no stats secret/
    );
  });

  it("reports a rejected secret as such, not as a crash", async () => {
    const built = await twoVariantTest();
    const { impl } = fakeFetch(401, { error: "stats secret required" });
    await expect(
      getStats.handler(
        { test: built.config, statsSecret: "wrong" },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/rejected that stats secret/);
  });

  it("declines to call a test that has barely run", async () => {
    const built = await twoVariantTest();
    const { impl } = fakeFetch(200, {
      ...statsBody,
      totalAssignments: 20,
      combinations: [
        {
          cell: 0,
          choice: ["control"],
          pulls: 10,
          conversions: 1,
          rewardTotal: 1,
          conversionRate: 0.1
        },
        {
          cell: 1,
          choice: ["variant"],
          pulls: 10,
          conversions: 2,
          rewardTotal: 2,
          conversionRate: 0.2
        }
      ]
    });
    const out = await getStats.handler(
      { test: built.config, statsSecret: built.statsSecret },
      { ...ctx, fetch: impl }
    );
    // Twice the conversion rate by eye, and still nowhere near callable.
    expect(out.decision.canStop).toBe(false);
    expect(out.decision.advice).toMatch(/too early/i);
  });
});

describe("upload_image", () => {
  const PNG_B64 = btoa("\x89PNG-fake-bytes");

  function assetServer(status = 201) {
    const calls: Array<{ url: string; contentType?: string; size: number }> =
      [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as Uint8Array;
      calls.push({
        url: String(url),
        contentType: (init?.headers as Record<string, string>)["content-type"],
        size: body.byteLength
      });
      if (status !== 201) {
        return Response.json({ error: "image exceeds 10 bytes" }, { status });
      }
      return Response.json(
        {
          assetId: "a".repeat(64),
          url: `https://livevariant.link/a/${"a".repeat(64)}`,
          previewUrl: `https://livevariant.link/a/${"a".repeat(64)}?e=1&s=x`,
          size: body.byteLength,
          contentType: (init?.headers as Record<string, string>)["content-type"]
        },
        { status: 201 }
      );
    }) as unknown as typeof globalThis.fetch;
    return { calls, impl };
  }

  it("uploads decoded bytes and returns the protected URL", async () => {
    const { calls, impl } = assetServer();
    const out = await uploadImage.handler(
      { data: PNG_B64, contentType: "image/png" },
      { ...ctx, fetch: impl }
    );
    expect(calls[0].url).toBe("https://livevariant.link/assets");
    expect(calls[0].contentType).toBe("image/png");
    // Decoded, not forwarded as base64: the server hashes raw bytes.
    expect(calls[0].size).toBe(atob(PNG_B64).length);
    expect(out.url).toContain("/a/");
    expect(out.previewUrl).toContain("e=");
  });

  it("says plainly when a deployment has no asset hosting", async () => {
    const { impl } = assetServer(404);
    await expect(
      uploadImage.handler(
        { data: PNG_B64, contentType: "image/png" },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/does not have asset hosting enabled/);
  });

  it("passes the server's own refusal through readably", async () => {
    const { impl } = assetServer(413);
    await expect(
      uploadImage.handler(
        { data: PNG_B64, contentType: "image/png" },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/exceeds 10 bytes/);
  });

  it("rejects garbage base64 before touching the network", async () => {
    await expect(
      uploadImage.handler(
        { data: "not!!base64$$", contentType: "image/png" },
        ctx
      )
    ).rejects.toThrow(/not valid base64/);
  });
});

describe("variant_brief", () => {
  it("gives email image specs that reflect how email actually behaves", async () => {
    const out = await variantBrief.handler(
      {
        goal: "more demo bookings",
        channel: "email",
        format: "image",
        count: 3
      },
      ctx
    );
    expect(out.variantCount).toBe(3);
    expect(out.specs.join(" ")).toMatch(/600px/);
    expect(out.specs.join(" ")).toMatch(/block images/i);
    expect(out.rules.join(" ")).toMatch(/one idea per slot/i);
  });

  it("tells the caller assets are theirs to host", async () => {
    const out = await variantBrief.handler(
      { goal: "x", channel: "web", format: "url", count: 2 },
      ctx
    );
    expect(out.hosting).toMatch(/host the assets yourself/i);
  });
});

describe("get_test_status", () => {
  it("takes the secret from a manage URL and relays the registry", async () => {
    const built = await twoVariantTest();
    const calls: Array<{ encoded: string; statsSecret: string }> = [];
    const out = await getTestStatus.handler(
      { test: built.urls.manage },
      {
        ...ctx,
        accounts: {
          listTests: () => Promise.reject(new Error("not needed")),
          testStatus: async input => {
            calls.push(input);
            return {
              ok: true as const,
              testId: built.testId,
              claimed: true,
              org: { id: "org-1", name: "Acme" },
              destinations: [{ host: "cdn.example.com", verified: true }]
            };
          }
        }
      }
    );
    // The re-encoded config is canonical, so the registry is asked about
    // the SAME test the manage URL named.
    expect(calls).toEqual([
      { encoded: built.config, statsSecret: built.statsSecret }
    ]);
    expect(out).toEqual({
      testId: built.testId,
      claimed: true,
      org: "Acme",
      destinations: [{ host: "cdn.example.com", verified: true }]
    });
  });

  it("rejects without a registry, a secret, or with the wrong secret", async () => {
    const built = await twoVariantTest();
    await expect(
      getTestStatus.handler(
        { test: built.config, statsSecret: built.statsSecret },
        ctx
      )
    ).rejects.toThrow(/no account registry/);
    const accounts = {
      listTests: () => Promise.reject(new Error("not needed")),
      testStatus: async () => ({
        ok: false as const,
        reason: "bad-secret" as const
      })
    };
    await expect(
      getTestStatus.handler({ test: built.config }, { ...ctx, accounts })
    ).rejects.toThrow(/no stats secret/);
    await expect(
      getTestStatus.handler(
        { test: built.config, statsSecret: "wrong-but-long-enough" },
        { ...ctx, accounts }
      )
    ).rejects.toThrow(/does not match/);
  });
});
