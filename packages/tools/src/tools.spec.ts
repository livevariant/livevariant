import { describe, expect, it } from "vitest";
import { decodeConfig, hashStatsSecret } from "@livevariant/core";
import {
  TOOLS,
  buildTest,
  findTool,
  generatePriors,
  getStats,
  inspectTest,
  recommendAlgorithmTool,
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

  it("only reaches the network where results are involved", () => {
    expect(getStats.reachesNetwork).toBe(true);
    for (const tool of TOOLS.filter(t => t !== getStats)) {
      expect(tool.reachesNetwork).toBe(false);
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
    expect(decoded.config.arms.map(a => a.name)).toEqual(["hero", "v2"]);
    expect(decoded.config.statsKeyHash).toBe(
      await hashStatsSecret(out.statsSecret)
    );
    expect(out.config).not.toContain(out.statsSecret);
  });

  it("picks an algorithm and says why, without being asked", async () => {
    const plain = await twoVariantTest();
    expect(plain.algorithm.chosen).toBe("ts");
    expect(plain.algorithm.reasoning).toMatch(/no context/i);

    const contextual = await buildTest.handler(
      {
        variants: [{ url: A }, { url: B }],
        context: [{ key: "country", values: ["nl", "de"] }],
        expectedTraffic: 100000
      },
      ctx
    );
    expect(contextual.algorithm.chosen).toBe("bucketed");
  });

  it("says what it would have chosen when overruled", async () => {
    const out = await buildTest.handler(
      {
        variants: [{ url: A }, { url: B }],
        algorithm: "linear",
        context: [{ key: "x" }]
      },
      ctx
    );
    expect(out.algorithm.chosen).toBe("linear");
    expect(out.algorithm.reasoning).toMatch(/recommendation would have been/i);
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

  it("warns when a derived dimension is far too wide to bucket", async () => {
    const out = await buildTest.handler(
      {
        variants: [{ url: A }, { url: B }],
        algorithm: "bucketed",
        context: [{ key: "city", from: "city" }]
      },
      ctx
    );
    expect(out.warnings.join(" ")).toMatch(/starve/i);
  });

  it("builds an ESP template whose variant fields come first", async () => {
    const out = await twoVariantTest();
    expect(out.emailTemplate.imageSrc).toContain("v={{variant_1_url}}");
    expect(out.emailTemplate.imageSrc).toContain("v={{variant_2_url}}");
    // The fixed hash last, so the editable fields are readable up front.
    expect(out.emailTemplate.imageSrc).toMatch(/&kh=[0-9a-f]{64}$/);
    // Email defaults to no derived context, which is the honest setting.
    expect(out.emailTemplate.imageSrc).toContain("auto=0");
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
    expect(out.variants).toHaveLength(2);
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
        algorithm: "bucketed",
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

describe("recommend_algorithm", () => {
  it("moves from ts to bucketed to linear as context grows", async () => {
    const none = await recommendAlgorithmTool.handler({}, ctx);
    expect(none.algorithm).toBe("ts");

    const coarse = await recommendAlgorithmTool.handler(
      {
        context: [{ key: "device", values: ["mobile", "desktop"] }],
        expectedTraffic: 50000
      },
      ctx
    );
    expect(coarse.algorithm).toBe("bucketed");
    expect(coarse.estimatedBuckets).toBe(2);

    const wide = await recommendAlgorithmTool.handler(
      { context: [{ key: "city", from: "city" }] },
      ctx
    );
    expect(wide.algorithm).toBe("linear");
    expect(wide.estimatedBuckets).toBeGreaterThan(1000);
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
    expect(decoded.config.priors?.arms).toHaveLength(2);
  });

  it("turns a rate and a confidence into pseudo-counts that wash out", async () => {
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: 1, rate: 0.1 }],
        confidence: "high"
      },
      ctx
    );
    const prior = out.priors[1];
    expect(prior.alpha + prior.beta).toBeCloseTo(30, 5);
    expect(prior.alpha / (prior.alpha + prior.beta)).toBeCloseTo(0.1, 5);
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
    expect(out.priors[0].beta).toBeGreaterThan(0);
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
    expect(out.priors[1]).toEqual({ variant: "v2", alpha: 1, beta: 1 });
    expect(out.notes.join(" ")).toMatch(/uniform prior/i);
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
    alg: "ts",
    totalAssignments: 2000,
    arms: [
      { name: "control", pulls: 1000, conversions: 50, conversionRate: 0.05 },
      { name: "variant", pulls: 1000, conversions: 90, conversionRate: 0.09 }
    ],
    buckets: {},
    bySignal: { country: { nl: { pulls: 1200, conversions: 80 } } },
    suggestion: null,
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
    expect(out.variants[1].probabilityBest).toBeGreaterThan(0.99);
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
      arms: [
        { name: "control", pulls: 10, conversions: 1, conversionRate: 0.1 },
        { name: "variant", pulls: 10, conversions: 2, conversionRate: 0.2 }
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
    expect(out.rules.join(" ")).toMatch(/one thing at a time/i);
  });

  it("tells the caller assets are theirs to host", async () => {
    const out = await variantBrief.handler(
      { goal: "x", channel: "web", format: "url", count: 2 },
      ctx
    );
    expect(out.hosting).toMatch(/host the assets yourself/i);
  });
});
