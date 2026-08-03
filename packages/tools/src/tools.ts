import { z } from "zod";
import {
  analyzeOutcomes,
  buildTestUrls,
  capArmPriors,
  encodeConfig,
  generateStatsSecret,
  hashStatsSecret,
  recommendAlgorithm,
  testConfigSchema,
  AUTO_SIGNALS,
  CONFIG_SOFT_LIMIT,
  SIGNAL_CARDINALITY,
  type TestConfigInput
} from "@livevariant/core";
import { resolveTest, resolveVariantIndex } from "./resolve.js";
import { defineTool, ToolInputError, type ToolContext } from "./types.js";

/**
 * The toolset. Each definition is the only place its name, description and
 * behaviour are written down; MCP, REST, OpenAPI and the SKILL all read
 * from here.
 *
 * The shape of the product decides the shape of these tools. A test is its
 * config, so "create a test" returns a URL rather than writing a row, and
 * every tool that reads a test takes one as an argument. Nothing here has
 * a session, an account or an id to remember.
 */

const signalEnum = z.enum(AUTO_SIGNALS);

const testRef = z
  .string()
  .min(1)
  .describe(
    "The test: an encoded config, or any LiveVariant URL containing one " +
      "(serve, click, pixel, manage), or a query-parameter serve URL. Paste " +
      "whatever you have."
  );

const contextDim = z.object({
  key: z
    .string()
    .min(1)
    .describe("Dimension name, e.g. country. Becomes ?c_<key>= on serve URLs."),
  values: z
    .array(z.string().min(1))
    .min(2)
    .optional()
    .describe(
      "Allowed values, when they are enumerable. Anything else is rejected " +
        "at serving time, which is what stops a crafted URL inventing buckets."
    ),
  from: signalEnum
    .optional()
    .describe(
      "Fill this dimension from a signal the server derives, so the caller " +
        "never sends it. Network signals (country, device, …) are guessed " +
        "from the connection and are suppressed for proxied email fetches; " +
        "utm_* are read off the link and survive a proxy intact, which makes " +
        "them the reliable choice for email."
    )
});

const variantInput = z.object({
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Shown in stats and in the utm stamp. Defaults to v1, v2, …"),
  url: z
    .string()
    .url()
    .optional()
    .describe("Destination for redirect serving."),
  image: z.string().url().optional().describe("Image URL, for email variants."),
  html: z.string().optional().describe("Inline HTML, served by the SDK."),
  markdown: z
    .string()
    .optional()
    .describe("Inline markdown, served by the SDK."),
  text: z.string().optional().describe("Inline text, served by the SDK."),
  redirectUrl: z
    .string()
    .url()
    .optional()
    .describe("Where a click on this variant lands, if it differs per variant.")
});

/** The formats block, dropping the keys the caller left out. */
function formatsOf(v: z.infer<typeof variantInput>) {
  return {
    ...(v.url ? { url: v.url } : {}),
    ...(v.image ? { image: v.image } : {}),
    ...(v.html ? { html: v.html } : {}),
    ...(v.markdown ? { md: v.markdown } : {}),
    ...(v.text ? { text: v.text } : {})
  };
}

/** Where the dashboard and every credentialed call live. */
function originOf(context: ToolContext, override?: string): string {
  return (override ?? context.serverUrl).replace(/\/+$/, "");
}

/** Where visitors are sent. The same place, unless serving is split off. */
function serveOriginOf(context: ToolContext, override?: string): string {
  return (override ?? context.serveUrl ?? context.serverUrl).replace(
    /\/+$/,
    ""
  );
}

// ---------------------------------------------------------------------------

export const buildTest = defineTool({
  name: "build_test",
  title: "Build a test",
  summary:
    "Turn variants into a ready-to-use test: URLs, stats secret, algorithm",
  description:
    "Creates a LiveVariant A/B test from a set of variants and returns every " +
    "URL needed to run it, plus a freshly generated stats secret.\n\n" +
    "Nothing is registered anywhere: the config IS the test, encoded into the " +
    "URLs, and the test's identity is a hash of it. That means editing a " +
    "variant later produces a DIFFERENT test with its own empty history, " +
    "which is usually what you want per campaign but is worth saying out loud " +
    "to whoever you are building this for.\n\n" +
    "The stats secret is returned once and never again. Only its hash goes " +
    "into the config, so nobody, including this service, can recover it. Give " +
    "it to the person who will read the results.\n\n" +
    "Leave `algorithm` unset to have one chosen from the context and traffic " +
    "you describe.",
  readOnly: true,
  reachesNetwork: false,
  input: z.object({
    variants: z
      .array(variantInput)
      .min(2)
      .max(50)
      .describe("Two or more. The first is the control."),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("A label for your own reference."),
    algorithm: z
      .enum(["ts", "bucketed", "linear"])
      .optional()
      .describe("Omit to have one recommended from the context and traffic."),
    context: z
      .array(contextDim)
      .max(8)
      .optional()
      .describe("Dimensions to learn a separate winner for."),
    expectedTraffic: z
      .number()
      .positive()
      .optional()
      .describe(
        "Rough visitors over the test's life. Only used to pick an algorithm."
      ),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .describe("Where clicks land when a variant does not say."),
    variantParam: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe(
        "Stamp the served variant into this parameter on redirect, e.g. " +
          '"utm_content", so the test shows up in the customer\'s own analytics.'
      ),
    serverUrl: z
      .string()
      .url()
      .optional()
      .describe("Self-hosted deployments only.")
  }),
  output: z.object({
    testId: z.string(),
    config: z.string().describe("The encoded config: this is the test."),
    statsSecret: z.string().describe("Shown once. Store it now."),
    algorithm: z.object({ chosen: z.string(), reasoning: z.string() }),
    urls: z.object({
      serve: z.string(),
      click: z.string(),
      pixel: z.string(),
      manage: z.string(),
      serveNoAutoContext: z.string(),
      clickNoAutoContext: z.string()
    }),
    emailTemplate: z
      .object({ imageSrc: z.string(), linkHref: z.string() })
      .describe(
        "Query-parameter spelling for an ESP template: wire it once, then " +
          "campaign managers fill only the variant fields."
      ),
    warnings: z.array(z.string())
  }),
  async handler(input, context) {
    const statsSecret = generateStatsSecret();
    const recommendation = recommendAlgorithm({
      ctxDims: input.context ?? [],
      expectedTraffic: input.expectedTraffic
    });
    const algorithm = input.algorithm ?? recommendation.alg;
    const reasoning = input.algorithm
      ? `You chose ${input.algorithm}. (Unprompted, the recommendation would ` +
        `have been ${recommendation.alg}: ${recommendation.reasoning})`
      : recommendation.reasoning;

    const configInput: TestConfigInput = {
      v: 1,
      arms: input.variants.map((variant, i) => ({
        name: variant.name?.trim() || `v${i + 1}`,
        formats: formatsOf(variant),
        ...(variant.redirectUrl ? { redirectUrl: variant.redirectUrl } : {})
      })),
      alg: algorithm,
      ...(input.name ? { name: input.name } : {}),
      ...(input.context?.length ? { ctx: { dims: input.context } } : {}),
      ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
      ...(input.variantParam ? { variantParam: input.variantParam } : {}),
      statsKeyHash: await hashStatsSecret(statsSecret)
    };

    let encoded: Awaited<ReturnType<typeof encodeConfig>>;
    try {
      encoded = await encodeConfig(configInput);
    } catch (err) {
      throw new ToolInputError(
        err instanceof Error ? err.message : "that test will not encode"
      );
    }

    const serveOrigin = serveOriginOf(context, input.serverUrl);
    const manageOrigin = originOf(context, input.serverUrl);
    const urls = buildTestUrls(
      serveOrigin,
      encoded.encoded,
      statsSecret,
      manageOrigin
    );
    const warnings = [...encoded.warnings];
    const inlineOnly = input.variants.filter(v => !v.url && !v.image);
    if (inlineOnly.length > 0 && inlineOnly.length < input.variants.length) {
      warnings.push(
        "Some variants have no url/image, so this test cannot be served by " +
          "redirect (email) at all: those URLs will 400. Give every variant a " +
          "url or image, or use it through the SDK only."
      );
    }
    for (const dim of input.context ?? []) {
      const size = dim.from ? SIGNAL_CARDINALITY[dim.from] : undefined;
      if (size !== undefined && size > 1000 && algorithm === "bucketed") {
        warnings.push(
          `Context "${dim.key}" comes from ${dim.from}, which has on the order ` +
            `of ${size} distinct values. Bucketed learning will starve at that ` +
            `width; linear generalizes across contexts instead.`
        );
      }
    }

    return {
      testId: encoded.testId,
      config: encoded.encoded,
      statsSecret,
      algorithm: { chosen: algorithm, reasoning },
      urls: {
        serve: urls.serve,
        click: urls.click,
        pixel: urls.pixel,
        manage: urls.manage,
        serveNoAutoContext: urls.noAuto.serve,
        clickNoAutoContext: urls.noAuto.click
      },
      emailTemplate: {
        imageSrc:
          `${serveOrigin}/s?${input.variants.map((_, i) => `v={{variant_${i + 1}_url}}`).join("&")}` +
          `&auto=0&id={{recipient_id}}&kh=${configInput.statsKeyHash}`,
        linkHref:
          `${serveOrigin}/c?${input.variants.map((_, i) => `v={{variant_${i + 1}_url}}`).join("&")}` +
          `&r={{landing_url}}&auto=0&id={{recipient_id}}&kh=${configInput.statsKeyHash}`
      },
      warnings
    };
  }
});

// ---------------------------------------------------------------------------

export const inspectTest = defineTool({
  name: "inspect_test",
  title: "Inspect a test",
  summary:
    "Decode any test URL and report what it will actually do, with warnings",
  description:
    "Decodes a test and describes it: variants, algorithm, context, and " +
    "whether it can be served by redirect. Also lints it for the mistakes " +
    "that only show up once a campaign is out, such as an email test whose " +
    "context comes from geo (which a mail proxy answers about itself) or a " +
    "bucketed test with far more buckets than traffic.\n\n" +
    "Use this before sending anything, and to answer 'what is this link?'.",
  readOnly: true,
  reachesNetwork: false,
  input: z.object({ test: testRef }),
  output: z.object({
    testId: z.string(),
    name: z.string().optional(),
    algorithm: z.string(),
    variants: z.array(
      z.object({
        name: z.string(),
        formats: z.array(z.string()),
        servesByRedirect: z.boolean()
      })
    ),
    context: z.array(
      z.object({
        key: z.string(),
        from: z.string().optional(),
        values: z.array(z.string()).optional()
      })
    ),
    resultsReadable: z
      .boolean()
      .describe("False when the config has no stats key, which is permanent."),
    findings: z.array(
      z.object({
        level: z.enum(["error", "warning", "note"]),
        message: z.string()
      })
    )
  }),
  async handler(input) {
    const { config, testId } = await resolveTest(input.test);
    const findings: Array<{
      level: "error" | "warning" | "note";
      message: string;
    }> = [];

    const variants = config.arms.map(arm => ({
      name: arm.name,
      formats: Object.keys(arm.formats),
      servesByRedirect: Boolean(arm.formats.url ?? arm.formats.image)
    }));
    if (variants.some(v => !v.servesByRedirect)) {
      findings.push({
        level: "error",
        message:
          "At least one variant has no url or image, so the serve URL will " +
          "return 400 for everyone, not just for that variant. Redirect " +
          "serving checks every variant up front so a visitor can never be " +
          "stuck on one that cannot be shown."
      });
    }
    if (!config.statsKeyHash) {
      findings.push({
        level: "error",
        message:
          "No stats key: this test will serve and learn, but its results can " +
          "never be read by anyone, because no secret can match a hash that " +
          "is not there. Rebuild it to get a readable one."
      });
    }

    const dims = config.ctx?.dims ?? [];
    const buckets = dims.reduce(
      (product, dim) =>
        product *
        (dim.values?.length ?? (dim.from ? SIGNAL_CARDINALITY[dim.from] : 8)),
      1
    );
    if (config.alg === "bucketed" && buckets > 50) {
      findings.push({
        level: "warning",
        message:
          `Roughly ${buckets} context combinations on a bucketed test. Each ` +
          "bucket learns alone and falls back to the global model until it " +
          "has its own traffic, so this will mostly serve the global winner. " +
          "linear shares what it learns across contexts."
      });
    }
    const networkDims = dims.filter(d => d.from && !d.from.startsWith("utm_"));
    if (networkDims.length > 0) {
      findings.push({
        level: "note",
        message:
          `Context ${networkDims.map(d => d.key).join(", ")} is derived from the ` +
          "connection. In email that is the mail provider's infrastructure, " +
          "not the reader, so it is suppressed for proxied fetches and those " +
          "recipients get no context at all. utm_* dimensions are read off " +
          "the link and survive intact."
      });
    }
    if (config.alg !== "ts" && dims.length === 0) {
      findings.push({
        level: "error",
        message: `Algorithm ${config.alg} needs context dimensions and has none.`
      });
    }

    return {
      testId,
      ...(config.name ? { name: config.name } : {}),
      algorithm: config.alg,
      variants,
      context: dims.map(d => ({
        key: d.key,
        ...(d.from ? { from: d.from } : {}),
        ...(d.values ? { values: d.values } : {})
      })),
      resultsReadable: Boolean(config.statsKeyHash),
      findings
    };
  }
});

// ---------------------------------------------------------------------------

export const recommendAlgorithmTool = defineTool({
  name: "recommend_algorithm",
  title: "Recommend an algorithm",
  summary:
    "Pick ts / bucketed / linear from the context and traffic, with reasoning",
  description:
    "Chooses between plain Thompson sampling, per-bucket Thompson sampling " +
    "and a linear contextual bandit for a test you are planning, and explains " +
    "why. The trade-off is always the same one: per-bucket learning is " +
    "assumption-free but needs enough traffic in every bucket, and linear " +
    "generalizes across contexts at the cost of assuming they combine " +
    "additively.\n\n" +
    "Algorithm is outside a test's identity hash, so this is never a " +
    "permanent decision: changing it later keeps the test's id and its whole " +
    "event history, and a recompute rebuilds the model.",
  readOnly: true,
  reachesNetwork: false,
  input: z.object({
    context: z.array(contextDim).max(8).optional(),
    expectedTraffic: z.number().positive().optional()
  }),
  output: z.object({
    algorithm: z.enum(["ts", "bucketed", "linear"]),
    reasoning: z.string(),
    estimatedBuckets: z.number()
  }),
  async handler(input) {
    const dims = input.context ?? [];
    const result = recommendAlgorithm({
      ctxDims: dims,
      expectedTraffic: input.expectedTraffic
    });
    const estimatedBuckets = dims.reduce(
      (product, dim) =>
        product *
        (dim.values?.length ?? (dim.from ? SIGNAL_CARDINALITY[dim.from] : 8)),
      1
    );
    return {
      algorithm: result.alg,
      reasoning: result.reasoning,
      estimatedBuckets
    };
  }
});

// ---------------------------------------------------------------------------

const CONFIDENCE_STRENGTH = { low: 5, medium: 15, high: 30 } as const;

export const generatePriors = defineTool({
  name: "generate_priors",
  title: "Add warm-start priors",
  summary: "Turn your predictions into capped pseudo-counts and embed them",
  description:
    "Takes YOUR estimate of how each variant will perform and converts it " +
    "into the prior the bandit starts from, so a test does not spend its " +
    "first visitors rediscovering what you already suspect.\n\n" +
    "You supply the guess; this does the arithmetic and the capping. That " +
    "capping is the point: a prior is expressed as pseudo-observations, and " +
    "it is deliberately held weak enough that real data overrides it quickly. " +
    "The response says exactly how many real visitors per variant it takes to " +
    "wash your guess out, so you can judge whether you have been too " +
    "confident. Being wrong here costs a little early traffic, not the test.\n\n" +
    "Priors are outside the identity hash, so the test keeps its id, its URLs " +
    "and any history it already has.",
  readOnly: true,
  reachesNetwork: false,
  input: z.object({
    test: testRef,
    beliefs: z
      .array(
        z.object({
          variant: z
            .union([z.string(), z.number().int()])
            .describe("Variant name or index."),
          rate: z
            .number()
            .min(0)
            .max(1)
            .describe("Your estimate of its conversion rate, e.g. 0.04 for 4%.")
        })
      )
      .min(1),
    confidence: z
      .union([z.enum(["low", "medium", "high"]), z.number().positive()])
      .default("medium")
      .describe(
        "How much your guess is worth in observations. low=5, medium=15, " +
          "high=30, or give a number directly. Higher means the test trusts " +
          "you for longer before the data takes over."
      )
  }),
  output: z.object({
    testId: z.string(),
    config: z.string(),
    manageUrl: z.string(),
    priors: z.array(
      z.object({ variant: z.string(), alpha: z.number(), beta: z.number() })
    ),
    washesOutAfter: z
      .number()
      .describe(
        "Roughly this many real visitors per variant and your guess stops mattering."
      ),
    notes: z.array(z.string())
  }),
  async handler(input, context) {
    const { config, testId } = await resolveTest(input.test);
    const names = config.arms.map(arm => arm.name);
    const strength =
      typeof input.confidence === "number"
        ? input.confidence
        : CONFIDENCE_STRENGTH[input.confidence];

    // Start from the uniform prior and only move the variants named, so a
    // partial belief ("B will beat A") does not silently reset the rest.
    const arms = config.arms.map(() => ({ alpha: 1, beta: 1 }));
    const notes: string[] = [];
    for (const belief of input.beliefs) {
      const index = resolveVariantIndex(names, belief.variant);
      // Clamped: a stated 0 or 1 is a claim of certainty that no amount of
      // contrary evidence could ever be, which is never what is meant.
      const rate = Math.min(0.999, Math.max(0.001, belief.rate));
      if (rate !== belief.rate) {
        notes.push(
          `Rate for ${names[index]} clamped to ${rate}: a prior of exactly ` +
            `${belief.rate} asserts certainty and would resist any evidence.`
        );
      }
      arms[index] = { alpha: rate * strength, beta: (1 - rate) * strength };
    }
    const unnamed = names.filter(
      (_, i) =>
        !input.beliefs.some(b => resolveVariantIndex(names, b.variant) === i)
    );
    if (unnamed.length > 0) {
      notes.push(
        `No belief given for ${unnamed.join(", ")}, so they keep the uniform ` +
          "prior. That makes them look neither good nor bad, which is the " +
          "honest default, but it does mean the ones you did rate start ahead."
      );
    }

    const capped = capArmPriors(arms, config.priorStrengthCap);
    if (capped.some((p, i) => p.alpha !== arms[i].alpha)) {
      notes.push(
        `Priors were scaled down to this test's cap of ${config.priorStrengthCap} ` +
          "pseudo-observations per variant, which is the safeguard against a " +
          "confident guess outvoting real traffic."
      );
    }

    const next = testConfigSchema.parse({
      ...config,
      priors: { ...config.priors, arms: capped }
    });
    const encoded = await encodeConfig(next);
    if (encoded.testId !== testId) {
      // Cannot happen: priors are identity-excluded. Loud if it ever does,
      // because silently forking a live test loses its history.
      throw new Error(
        "adding priors changed the test id, which would orphan its history"
      );
    }
    const origin = originOf(context);
    return {
      testId: encoded.testId,
      config: encoded.encoded,
      manageUrl: `${origin}/manage/${encoded.encoded}`,
      priors: capped.map((p, i) => ({
        variant: names[i],
        alpha: p.alpha,
        beta: p.beta
      })),
      washesOutAfter: Math.round(Math.min(strength, config.priorStrengthCap)),
      notes
    };
  }
});

// ---------------------------------------------------------------------------

export const getStats = defineTool({
  name: "get_stats",
  title: "Read a test's results",
  summary: "Live results plus win probabilities and a stop/continue call",
  description:
    "Fetches a test's results and works out what they mean.\n\n" +
    "Alongside the raw counts it returns the probability that each variant " +
    "is genuinely best and the expected cost of stopping now and keeping the " +
    "leader. Use those rather than comparing conversion rates by eye: a " +
    "variant ahead 2/10 to 1/10 looks twice as good and is very close to a " +
    "coin flip, and that mistake is the single most common way an A/B test " +
    "gets called wrong.\n\n" +
    "Needs the stats secret. If you have the manage URL, its #fragment IS the " +
    "secret and it will be used automatically.",
  readOnly: true,
  reachesNetwork: true,
  input: z.object({
    test: testRef,
    statsSecret: z
      .string()
      .optional()
      .describe(
        "Omit when passing a manage URL that carries it in the fragment."
      )
  }),
  output: z.object({
    testId: z.string(),
    algorithm: z.string(),
    totalAssignments: z.number(),
    variants: z.array(
      z.object({
        name: z.string(),
        pulls: z.number(),
        conversions: z.number(),
        conversionRate: z.number().nullable(),
        probabilityBest: z.number()
      })
    ),
    decision: z.object({
      leader: z.string(),
      canStop: z.boolean(),
      expectedLossIfStoppingNow: z.number(),
      relativeLoss: z.number(),
      advice: z.string()
    }),
    contextBuckets: z.number(),
    bySignal: z.record(
      z.string(),
      z.record(
        z.string(),
        z.object({ pulls: z.number(), conversions: z.number() })
      )
    ),
    algorithmSuggestion: z
      .object({ alg: z.string(), reasoning: z.string() })
      .nullable(),
    excluded: z.object({
      total: z.number(),
      bySource: z.number(),
      byWindow: z.number()
    })
  }),
  async handler(input, context) {
    const resolved = await resolveTest(input.test);
    const secret = input.statsSecret ?? resolved.statsSecret;
    if (!secret) {
      throw new ToolInputError(
        "no stats secret: pass statsSecret, or the manage URL whose #fragment holds it"
      );
    }
    // The origin for a credentialed request comes from configuration, never
    // from the pasted URL. `test` is attacker-reachable: it arrives from a
    // document, an email, or an injected instruction, while the secret can
    // come from trusted context earlier in the conversation. Honouring the
    // URL's own origin would send that secret wherever the URL said.
    //
    // A mismatch is refused rather than silently redirected, so a
    // self-hoster is told to configure their deployment instead of quietly
    // querying the wrong server.
    const origin = originOf(context);
    const known = [origin, serveOriginOf(context)];
    if (resolved.serverUrl && !known.includes(resolved.serverUrl)) {
      throw new ToolInputError(
        `that URL points at ${resolved.serverUrl}, but this client is ` +
          `configured for ${known.join(" and ")}. The stats secret is only ` +
          "ever sent to the configured server. If that deployment is yours, " +
          "set LIVEVARIANT_SERVER_URL to it; otherwise do not trust the link."
      );
    }
    const encoded = (await encodeConfig(resolved.config)).encoded;
    const response = await context.fetch(`${origin}/stats/${encoded}`, {
      headers: { authorization: `Bearer ${secret}` }
    });
    if (response.status === 401) {
      throw new ToolInputError(
        "the server rejected that stats secret for this test",
        401
      );
    }
    if (!response.ok) {
      // 404 means the server has never seen this test, which is the
      // caller's problem; anything else is the server's, and saying so
      // stops an outage reading as a bad config.
      throw new ToolInputError(
        `stats request failed (${response.status})`,
        response.status === 404 ? 404 : 502
      );
    }
    const stats = (await response.json()) as {
      testId: string;
      alg: string;
      totalAssignments: number;
      arms: Array<{
        name?: string;
        pulls: number;
        conversions: number;
        conversionRate: number | null;
      }>;
      buckets: Record<string, unknown>;
      bySignal: Record<
        string,
        Record<string, { pulls: number; conversions: number }>
      >;
      suggestion: { alg: string; reasoning: string } | null;
      excluded: { total: number; bySource: number; byWindow: number };
    };

    const analysis = analyzeOutcomes(
      stats.arms.map(arm => ({
        pulls: arm.pulls,
        conversions: arm.conversions
      }))
    );
    const names = stats.arms.map((arm, i) => arm.name ?? `v${i + 1}`);
    const leader = names[analysis.leader] ?? "none";
    const advice = adviceFor(stats.totalAssignments, analysis, leader);

    return {
      testId: stats.testId,
      algorithm: stats.alg,
      totalAssignments: stats.totalAssignments,
      variants: stats.arms.map((arm, i) => ({
        name: names[i],
        pulls: arm.pulls,
        conversions: arm.conversions,
        conversionRate: arm.conversionRate,
        probabilityBest: analysis.probabilities[i] ?? 0
      })),
      decision: {
        leader,
        canStop: analysis.canStop,
        expectedLossIfStoppingNow: analysis.expectedLoss,
        relativeLoss: analysis.relativeLoss,
        advice
      },
      contextBuckets: Object.keys(stats.buckets).length,
      bySignal: stats.bySignal,
      algorithmSuggestion: stats.suggestion,
      excluded: stats.excluded
    };
  }
});

function adviceFor(
  total: number,
  analysis: ReturnType<typeof analyzeOutcomes>,
  leader: string
): string {
  if (total === 0) {
    return "Nothing has been served yet, so there is nothing to read.";
  }
  if (analysis.canStop) {
    return (
      `${leader} is the winner: keeping it now risks about ` +
      `${(analysis.expectedLoss * 100).toFixed(2)} conversion-rate points, ` +
      "which is within the usual 1% threshold. Note the bandit has already " +
      "been shifting traffic toward it the whole time, so there is no rush " +
      "to act on this."
    );
  }
  return (
    `Too early to call. ${leader} leads with ` +
    `${(analysis.probabilities[analysis.leader] * 100).toFixed(0)}% probability ` +
    "of being best, and stopping now would risk about " +
    `${(analysis.expectedLoss * 100).toFixed(2)} conversion-rate points. ` +
    "Letting it run costs little, because traffic is already being weighted " +
    "toward whichever variant is ahead."
  );
}

// ---------------------------------------------------------------------------

export const variantBrief = defineTool({
  name: "variant_brief",
  title: "Brief for writing variants",
  summary:
    "Channel-specific specs and rules for drafting the variants themselves",
  description:
    "Returns the constraints to write or generate test variants against, for " +
    "email or web, plus the rules that decide whether a test can be read at " +
    "all once it runs.\n\n" +
    "The one that matters most: change one thing at a time, or accept that " +
    "the result tells you the bundle won and not which part of it did. Ask " +
    "for this before drafting variants, then produce them yourself against " +
    "what it returns.",
  readOnly: true,
  reachesNetwork: false,
  input: z.object({
    goal: z
      .string()
      .min(1)
      .describe("What the test should improve, e.g. 'more demo bookings'."),
    channel: z.enum(["email", "web"]),
    format: z
      .enum(["image", "text", "html", "url"])
      .describe("What each variant will be."),
    count: z.number().int().min(2).max(10).default(2),
    audience: z
      .string()
      .optional()
      .describe("Who sees it, if that shapes the copy.")
  }),
  output: z.object({
    goal: z.string(),
    variantCount: z.number(),
    specs: z.array(z.string()),
    rules: z.array(z.string()),
    hosting: z.string(),
    nextStep: z.string()
  }),
  async handler(input) {
    const specs: string[] = [];
    if (input.format === "image") {
      specs.push(
        "600px content width is the email standard; export at 1200px for " +
          "retina and let it scale down.",
        "It must still read at 320px wide: phones are most of the audience.",
        "Keep the message in the surrounding text too. Many clients block " +
          "images by default, so an image-only pitch reaches nobody with a " +
          "blocked-image setting, and the same applies to screen readers.",
        "Write alt text per variant that carries the same message."
      );
    }
    if (input.format === "text" || input.format === "html") {
      specs.push(
        "Keep the variants within a similar length of each other, or you are " +
          "also testing how much the layout moves.",
        input.channel === "email"
          ? "Inline styles only, and assume no web fonts."
          : "No layout shift when the variant swaps in: reserve the space."
      );
    }
    if (input.format === "url") {
      specs.push(
        "Every variant needs a publicly reachable https URL before the test " +
          "can serve, and the destinations should differ in the thing being " +
          "tested rather than in tracking parameters."
      );
    }

    return {
      goal: input.goal,
      variantCount: input.count,
      specs,
      rules: [
        `Produce ${input.count} variants. The first is the control: it should ` +
          "be what you run today, so the test measures a change rather than " +
          "two guesses against each other.",
        "Change one thing at a time. If you vary headline and image together, " +
          "a win tells you the pair beat the pair, not which half did it.",
        "Make them genuinely different. Two paraphrases of one sentence need " +
          "enormous traffic to separate, and usually just cost you the time.",
        "Do not write a variant you would be unwilling to ship: a bandit sends " +
          "real traffic to all of them while it learns.",
        ...(input.audience ? [`Write for: ${input.audience}.`] : [])
      ],
      hosting:
        input.format === "image" || input.format === "url"
          ? "Host the assets yourself and pass the public URLs as variants. " +
            "Nothing is uploaded here: the config only ever holds URLs."
          : "Inline content travels inside the config, so keep it short. " +
            "Anything substantial should be a hosted URL instead.",
      nextStep:
        "Draft the variants against this, then call build_test with them to " +
        "get the URLs and the stats secret."
    };
  }
});

// ---------------------------------------------------------------------------

/** Every tool, in the order a person meets them. */
export const TOOLS = [
  buildTest,
  inspectTest,
  recommendAlgorithmTool,
  generatePriors,
  getStats,
  variantBrief
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export function findTool(name: string) {
  return TOOLS.find(tool => tool.name === name);
}

/** Soft ceiling worth surfacing in docs alongside the tools. */
export const CONFIG_URL_SOFT_LIMIT = CONFIG_SOFT_LIMIT;
