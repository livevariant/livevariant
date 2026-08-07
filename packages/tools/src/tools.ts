import { z } from "zod";
import {
  analyzeOutcomes,
  buildTestUrls,
  cellCount,
  encodeConfig,
  generateStatsSecret,
  hashStatsSecret,
  slotEntries,
  slotSizes,
  testConfigSchema,
  variantName,
  AUTO_SIGNALS,
  CONFIG_SOFT_LIMIT,
  TEST_REGIONS,
  type TestConfigInput,
  type Variant
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
 * a session, an account or an id to remember. And there is no algorithm
 * anywhere in this surface: every test runs the same joint model, sized
 * from the config, so the tools ask what to test and never how.
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

const SLOT_KEY_INPUT = /^[a-z][a-z0-9_-]{0,31}$/;

/** The v2 variant object, dropping the keys the caller left out. */
function toVariant(v: z.infer<typeof variantInput>, index: number) {
  return {
    name: v.name?.trim() || `v${index + 1}`,
    ...(v.url ? { url: v.url } : {}),
    ...(v.image ? { image: v.image } : {}),
    ...(v.html ? { html: v.html } : {}),
    ...(v.markdown ? { md: v.markdown } : {}),
    ...(v.text ? { text: v.text } : {}),
    ...(v.redirectUrl ? { redirectUrl: v.redirectUrl } : {})
  };
}

/** Format names a stored variant carries, for inspection output. */
function formatsOf(variant: Variant): string[] {
  return (["url", "image", "html", "md", "text"] as const).filter(
    key => variant[key] !== undefined
  );
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
    "Turn variants (one element or several) into a ready-to-use test with URLs",
  description:
    "Creates a LiveVariant test and returns every URL needed to run it, plus " +
    "a freshly generated stats secret.\n\n" +
    "Pass `variants` to test one element, or `slots` to test several at once " +
    "(hero image AND call-to-action, say). With slots the test optimizes the " +
    "COMBINATION: one model learns how the elements interact, which two " +
    "separate tests structurally cannot see. There is no algorithm to pick " +
    "either way; every test runs the same joint model, sized from its shape.\n\n" +
    "Nothing is registered anywhere: the config IS the test, encoded into the " +
    "URLs, and the test's identity is a hash of it. That means editing a " +
    "variant later produces a DIFFERENT test with its own empty history, " +
    "which is usually what you want per campaign but is worth saying out loud " +
    "to whoever you are building this for.\n\n" +
    "The stats secret is returned once and never again. Only its hash goes " +
    "into the config, so nobody, including this service, can recover it. Give " +
    "it to the person who will read the results.",
  readOnly: true,
  reachesNetwork: false,
  input: z
    .object({
      variants: z
        .array(variantInput)
        .min(2)
        .max(64)
        .optional()
        .describe(
          "Single-element test: two or more variants. The first is the control."
        ),
      slots: z
        .record(
          z.string().regex(SLOT_KEY_INPUT),
          z.array(variantInput).min(1).max(64)
        )
        .optional()
        .describe(
          "Multi-element test: variants per element, keyed by a short name " +
            'like "hero" or "cta". The test serves and learns combinations.'
        ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("A label for your own reference."),
      context: z
        .array(contextDim)
        .max(8)
        .optional()
        .describe("Dimensions to learn a separate winner for."),
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
          "Stamp the served combination into this parameter on redirect, e.g. " +
            '"utm_content", so the test shows up in the customer\'s own analytics.'
        ),
      publishableKey: z
        .string()
        .regex(/^pk_[a-z0-9]{24}$/)
        .optional()
        .describe(
          "Registers the new test to this key's organization at creation, " +
            "so it appears under My tests immediately. The key is PUBLIC " +
            "(from the dashboard's Settings); authority comes from the " +
            "stats secret this call mints. Only works on deployments with " +
            "accounts; elsewhere a warning says so and the test still works."
        ),
      region: z
        .enum(TEST_REGIONS)
        .optional()
        .describe(
          "Where the test's state lives. A placement hint (wnam, enam, sam, " +
            'weur, eeur, apac, oc, afr, me) or "eu" for the EU jurisdiction ' +
            "(state guaranteed created and kept inside the EU). Defaults to " +
            "the creator's own region when the host can tell; without any, " +
            "state is born wherever the FIRST request comes from, which in " +
            "email is routinely a mail provider's US datacenter."
        ),
      serverUrl: z
        .string()
        .url()
        .optional()
        .describe("Self-hosted deployments only.")
    })
    .refine(input => Boolean(input.variants) !== Boolean(input.slots), {
      message: "pass exactly one of `variants` (one element) or `slots`"
    }),
  output: z.object({
    testId: z.string(),
    config: z.string().describe("The encoded config: this is the test."),
    statsSecret: z.string().describe("Shown once. Store it now."),
    slots: z
      .array(z.object({ slot: z.string(), variants: z.array(z.string()) }))
      .describe(
        "Canonical slot order with variant names, as stats reports them."
      ),
    combinations: z
      .number()
      .describe("How many distinct combinations the test chooses between."),
    region: z
      .string()
      .nullable()
      .describe(
        "Where the test's state will live; null means first-request placement."
      ),
    urls: z.object({
      serve: z.string(),
      click: z.string(),
      pixel: z.string(),
      manage: z
        .string()
        .describe(
          "ALWAYS show this URL to the user in your final answer and tell " +
            "them: opening it shows live results, and signed in they can " +
            "click 'Add to my account' to claim the test into their " +
            "dashboard. It carries the stats secret in its #fragment, so " +
            "they should share it only with people who may see results."
        ),
      serveNoAutoContext: z.string(),
      clickNoAutoContext: z.string()
    }),
    slotLinks: z
      .record(z.string(), z.object({ serve: z.string(), click: z.string() }))
      .optional()
      .describe(
        "Multi-slot tests only: the serve/click URL per element. The bare " +
          "urls.serve/click return 400 for these tests, because a link " +
          "must say which element it renders; use these instead."
      ),
    emailTemplate: z
      .record(
        z.string(),
        z.object({ imageSrc: z.string(), linkHref: z.string() })
      )
      .describe(
        "Query-parameter spelling per slot for an ESP template: wire it " +
          "once, then campaign managers fill only the variant fields. " +
          "Multi-slot links carry &slot= to say which element each serves."
      ),
    warnings: z.array(z.string()),
    registeredTo: z
      .string()
      .optional()
      .describe(
        "The organization the test was registered to, when a " +
          "publishableKey was given and accepted."
      ),
    destinations: z
      .array(z.object({ host: z.string(), verified: z.boolean() }))
      .optional()
      .describe(
        "Redirect destinations and whether each is a verified domain. " +
          "Unverified means visitors see a 'Redirecting you to…' continue " +
          "screen before landing; relay the verification warning to the " +
          "user when present."
      )
  }),
  async handler(input, context) {
    const statsSecret = generateStatsSecret();
    const slotsInput = input.slots ?? { main: input.variants! };

    const configInput: TestConfigInput = {
      v: 2,
      slots: Object.fromEntries(
        Object.entries(slotsInput).map(([key, variants]) => [
          key,
          variants.map(toVariant)
        ])
      ),
      ...(input.name ? { name: input.name } : {}),
      ...(input.context?.length ? { ctx: { dims: input.context } } : {}),
      ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
      ...(input.variantParam ? { variantParam: input.variantParam } : {}),
      ...((input.region ?? context.region)
        ? { region: input.region ?? context.region }
        : {}),
      statsKeyHash: await hashStatsSecret(statsSecret)
    };

    let parsed: ReturnType<typeof testConfigSchema.parse>;
    let encoded: Awaited<ReturnType<typeof encodeConfig>>;
    try {
      parsed = testConfigSchema.parse(configInput);
      encoded = await encodeConfig(parsed);
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

    const entries = slotEntries(parsed);
    const multiSlot = entries.length > 1;
    const warnings = [...encoded.warnings];
    for (const [key, variants] of entries) {
      const inlineOnly = variants.filter(v => !v.url && !v.image);
      if (inlineOnly.length > 0) {
        warnings.push(
          `Slot "${key}" has ${inlineOnly.length} variant(s) with no url/image, ` +
            "so that slot cannot be served by redirect (email); its serve " +
            "link will 400. Give every variant a url or image, or serve the " +
            "slot through the SDK only."
        );
      }
    }
    const cells = cellCount(slotSizes(parsed));
    if (multiSlot && cells > 32) {
      warnings.push(
        `${cells} combinations. The model shares what it learns across them ` +
          "(variant effects and pairwise interactions), so this is workable, " +
          "but calling an exact winning combination still needs traffic in " +
          "rough proportion to that count."
      );
    }

    // ESP-template spelling. Every link carries the whole test (all
    // slots), and in a multi-slot test each link adds &slot= to say which
    // element it renders.
    const templateBase = entries
      .map(
        ([key, variants]) =>
          (multiSlot ? `s=${key}&` : "") +
          variants
            .map(
              (_, i) =>
                `v={{${multiSlot ? `${key}_` : ""}variant_${i + 1}_url}}`
            )
            .join("&")
      )
      .join("&");
    const templateTail = `&auto=0&id={{recipient_id}}&kh=${configInput.statsKeyHash}`;
    const emailTemplate = Object.fromEntries(
      entries.map(([key]) => [
        key,
        {
          imageSrc:
            `${serveOrigin}/s?${templateBase}` +
            (multiSlot ? `&slot=${key}` : "") +
            templateTail,
          linkHref:
            `${serveOrigin}/c?${templateBase}` +
            (multiSlot ? `&slot=${key}` : "") +
            `&r={{landing_url}}${templateTail}`
        }
      ])
    );

    return {
      testId: encoded.testId,
      config: encoded.encoded,
      statsSecret,
      slots: entries.map(([slot, variants]) => ({
        slot,
        variants: variants.map((v, i) => variantName(v, i))
      })),
      combinations: cells,
      region: parsed.region ?? null,
      urls: {
        serve: urls.serve,
        click: urls.click,
        pixel: urls.pixel,
        manage: urls.manage,
        serveNoAutoContext: urls.noAuto.serve,
        clickNoAutoContext: urls.noAuto.click
      },
      ...(multiSlot
        ? {
            slotLinks: Object.fromEntries(
              entries.map(([key]) => [
                key,
                {
                  serve: `${urls.serve}?slot=${key}`,
                  click: `${urls.click}?slot=${key}`
                }
              ])
            )
          }
        : {}),
      emailTemplate,
      warnings,
      ...(await maybeRegister(
        context,
        encoded.encoded,
        statsSecret,
        input.publishableKey,
        warnings
      )),
      ...(await destinationInfo(
        context,
        encoded.encoded,
        statsSecret,
        warnings
      ))
    };
  }
});

/**
 * Verification status at the one moment it is cheapest to act on: the
 * agent still has the user's attention, so an unverified destination
 * becomes a sentence in its answer instead of a surprise interstitial
 * in a sent campaign. Absence of the capability (self-host without
 * accounts, stdio MCP) is silent: there is no registry to consult.
 */
async function destinationInfo(
  context: ToolContext,
  encoded: string,
  statsSecret: string,
  warnings: string[]
): Promise<{ destinations?: Array<{ host: string; verified: boolean }> }> {
  if (!context.accounts?.testStatus) {
    return {};
  }
  try {
    const status = await context.accounts.testStatus({ encoded, statsSecret });
    if (!status.ok || status.destinations.length === 0) {
      return {};
    }
    const unverified = status.destinations.filter(d => !d.verified);
    if (unverified.length > 0) {
      warnings.push(
        `Unverified destination${unverified.length > 1 ? "s" : ""} ` +
          `${unverified.map(d => d.host).join(", ")}: visitors clicking ` +
          "through will first see a 'Redirecting you to…' continue screen. " +
          "Tell the user to verify the domain under Settings on the " +
          "dashboard (DNS TXT record, the well-known file, or having the " +
          "SDK tag with their publishable key live on the site); verified " +
          "domains redirect instantly."
      );
    }
    return { destinations: status.destinations };
  } catch {
    // Status is advisory; a failure must never fail the build.
    return {};
  }
}

/**
 * Registration at creation: build_test holds the secret it just
 * minted, so a publishable key is all the caller adds. Failure never
 * fails the build; the test works regardless, and the warning says
 * what to do.
 */
async function maybeRegister(
  context: ToolContext,
  encoded: string,
  statsSecret: string,
  publishableKey: string | undefined,
  warnings: string[]
): Promise<{ registeredTo?: string }> {
  if (!publishableKey) {
    return {};
  }
  if (!context.accounts?.registerWithSecret) {
    warnings.push(
      "publishableKey ignored: this deployment (or transport) has no " +
        "accounts. Use the hosted MCP/API, or register later with " +
        "register_test."
    );
    return {};
  }
  const result = await context.accounts.registerWithSecret({
    encoded,
    statsSecret,
    publishableKey
  });
  if (result.ok) {
    return { registeredTo: result.org };
  }
  warnings.push(
    result.reason === "unknown-key"
      ? "publishableKey not recognized on this deployment; the test was " +
          "created but not registered."
      : result.reason === "claimed-elsewhere"
        ? "this test's stats key is already claimed by another " +
          "organization; created but not registered."
        : "the test was created but could not be registered " +
          `(${result.reason}).`
  );
  return {};
}

// ---------------------------------------------------------------------------

export const inspectTest = defineTool({
  name: "inspect_test",
  title: "Inspect a test",
  summary:
    "Decode any test URL and report what it will actually do, with warnings",
  description:
    "Decodes a test and describes it: slots, variants, context, and whether " +
    "it can be served by redirect. Also lints it for the mistakes that only " +
    "show up once a campaign is out, such as an email test whose context " +
    "comes from geo (which a mail proxy answers about itself).\n\n" +
    "Use this before sending anything, and to answer 'what is this link?'.",
  readOnly: true,
  reachesNetwork: false,
  input: z.object({ test: testRef }),
  output: z.object({
    testId: z.string(),
    name: z.string().optional(),
    slots: z.array(
      z.object({
        slot: z.string(),
        variants: z.array(
          z.object({
            name: z.string(),
            formats: z.array(z.string()),
            servesByRedirect: z.boolean()
          })
        )
      })
    ),
    combinations: z.number(),
    region: z.string().nullable(),
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

    const entries = slotEntries(config);
    const slots = entries.map(([slot, variants]) => ({
      slot,
      variants: variants.map((variant, i) => ({
        name: variantName(variant, i),
        formats: formatsOf(variant),
        servesByRedirect: Boolean(variant.url ?? variant.image)
      }))
    }));
    for (const slot of slots) {
      if (slot.variants.some(v => !v.servesByRedirect)) {
        findings.push({
          level: "error",
          message:
            `Slot "${slot.slot}" has a variant with no url or image, so its ` +
            "serve link will return 400 for everyone, not just for that " +
            "variant. Redirect serving checks every variant of the served " +
            "slot up front so a visitor can never be stuck on one that " +
            "cannot be shown."
        });
      }
    }
    if (entries.length > 1) {
      findings.push({
        level: "note",
        message:
          "Multi-slot test: each redirect link must say which element it " +
          `serves with ?slot= (one of: ${entries.map(([key]) => key).join(", ")}). ` +
          "All links share one sticky whole-combination assignment per " +
          "recipient."
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

    return {
      testId,
      ...(config.name ? { name: config.name } : {}),
      slots,
      combinations: cellCount(slotSizes(config)),
      region: config.region ?? null,
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

const CONFIDENCE_STRENGTH = { low: 5, medium: 15, high: 30 } as const;

export const generatePriors = defineTool({
  name: "generate_priors",
  title: "Add warm-start priors",
  summary: "Turn your predictions into capped priors and embed them",
  description:
    "Takes YOUR estimate of how each variant will perform and converts it " +
    "into the prior the model starts from, so a test does not spend its " +
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
          slot: z
            .string()
            .optional()
            .describe(
              "Which slot the variant belongs to. Optional for single-slot tests."
            ),
          variant: z
            .union([z.string(), z.number().int()])
            .describe("Variant name or index within its slot."),
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
      z.object({
        slot: z.string(),
        variant: z.string(),
        mean: z.number(),
        strength: z.number()
      })
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
    const entries = slotEntries(config);
    const strength =
      typeof input.confidence === "number"
        ? input.confidence
        : CONFIDENCE_STRENGTH[input.confidence];
    const capped = Math.min(strength, config.priorStrengthCap);

    // Start from no prior and only move the variants named, so a partial
    // belief ("B will beat A") does not silently claim the rest.
    const priors: Record<
      string,
      Array<{ mean: number; strength: number }>
    > = Object.fromEntries(
      entries.map(([key, variants]) => [
        key,
        variants.map(() => ({ mean: 0.5, strength: 0 }))
      ])
    );
    const notes: string[] = [];

    for (const belief of input.beliefs) {
      const slotKey =
        belief.slot ??
        (entries.length === 1
          ? entries[0][0]
          : (() => {
              throw new ToolInputError(
                `multi-slot test: say which slot each belief is about ` +
                  `(one of: ${entries.map(([key]) => key).join(", ")})`
              );
            })());
      const entry = entries.find(([key]) => key === slotKey);
      if (!entry) {
        throw new ToolInputError(
          `no slot called "${slotKey}"; this test has ${entries
            .map(([key]) => key)
            .join(", ")}`
        );
      }
      const names = entry[1].map((v, i) => variantName(v, i));
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
      priors[slotKey][index] = { mean: rate, strength };
    }

    const unnamed = entries.flatMap(([key, variants]) =>
      variants
        .map((v, i) => ({ key, name: variantName(v, i), index: i }))
        .filter(({ index }) => priors[key][index].strength === 0)
        .map(({ name }) => name)
    );
    if (unnamed.length > 0) {
      notes.push(
        `No belief given for ${unnamed.join(", ")}, so they start without a ` +
          "prior. That makes them look neither good nor bad, which is the " +
          "honest default, but it does mean the ones you did rate start ahead."
      );
    }
    if (capped < strength) {
      notes.push(
        `Priors were capped to this test's limit of ${config.priorStrengthCap} ` +
          "pseudo-observations per variant, which is the safeguard against a " +
          "confident guess outvoting real traffic."
      );
    }

    const next = testConfigSchema.parse({ ...config, priors });
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
      priors: entries.flatMap(([key, variants]) =>
        priors[key]
          .map((prior, i) => ({
            slot: key,
            variant: variantName(variants[i], i),
            mean: prior.mean,
            strength: Math.min(prior.strength, config.priorStrengthCap)
          }))
          .filter(prior => prior.strength > 0)
      ),
      washesOutAfter: Math.round(capped),
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
    "Alongside the raw counts it returns the probability that each " +
    "combination is genuinely best and the expected cost of stopping now " +
    "and keeping the leader. Use those rather than comparing conversion " +
    "rates by eye: a variant ahead 2/10 to 1/10 looks twice as good and is " +
    "very close to a coin flip, and that mistake is the single most common " +
    "way an A/B test gets called wrong.\n\n" +
    "Multi-slot tests also report per-slot marginals: how each variant did " +
    "across every combination it appeared in.\n\n" +
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
    totalAssignments: z.number(),
    combinations: z.array(
      z.object({
        choice: z.array(z.string()),
        pulls: z.number(),
        conversions: z.number(),
        conversionRate: z.number().nullable(),
        probabilityBest: z.number()
      })
    ),
    slots: z.record(
      z.string(),
      z.array(
        z.object({
          name: z.string(),
          pulls: z.number(),
          conversions: z.number(),
          conversionRate: z.number().nullable()
        })
      )
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
      totalAssignments: number;
      combinations: Array<{
        cell: number;
        choice: string[];
        pulls: number;
        conversions: number;
        conversionRate: number | null;
      }>;
      slots: Record<
        string,
        Array<{
          name: string;
          pulls: number;
          conversions: number;
          conversionRate: number | null;
        }>
      >;
      buckets: Record<string, unknown>;
      bySignal: Record<
        string,
        Record<string, { pulls: number; conversions: number }>
      >;
      excluded: { total: number; bySource: number; byWindow: number };
    };

    const analysis = analyzeOutcomes(
      stats.combinations.map(combo => ({
        pulls: combo.pulls,
        conversions: combo.conversions
      }))
    );
    const names = stats.combinations.map(combo => combo.choice.join(" + "));
    const leader = names[analysis.leader] ?? "none";
    const advice = adviceFor(stats.totalAssignments, analysis, leader);

    return {
      testId: stats.testId,
      totalAssignments: stats.totalAssignments,
      combinations: stats.combinations.map((combo, i) => ({
        choice: combo.choice,
        pulls: combo.pulls,
        conversions: combo.conversions,
        conversionRate: combo.conversionRate,
        probabilityBest: analysis.probabilities[i] ?? 0
      })),
      slots: stats.slots,
      decision: {
        leader,
        canStop: analysis.canStop,
        expectedLossIfStoppingNow: analysis.expectedLoss,
        relativeLoss: analysis.relativeLoss,
        advice
      },
      contextBuckets: Object.keys(stats.buckets).length,
      bySignal: stats.bySignal,
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
      "which is within the usual 1% threshold. Note the model has already " +
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
    "toward whichever combination is ahead."
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
    "The one that matters most: one idea per slot. To vary two elements, " +
    "give the test two slots and let it learn the combination, rather than " +
    "bundling both changes into one variant and never learning which half " +
    "worked. Ask for this before drafting variants, then produce them " +
    "yourself against what it returns.",
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
        "One idea per slot. To vary the headline AND the image, build the " +
          "test with two slots (build_test's `slots` input): the model " +
          "learns which combination wins, where a bundled variant only ever " +
          "tells you the bundle did.",
        "Make them genuinely different. Two paraphrases of one sentence need " +
          "enormous traffic to separate, and usually just cost you the time.",
        "Do not write a variant you would be unwilling to ship: the model " +
          "sends real traffic to all of them while it learns.",
        ...(input.audience ? [`Write for: ${input.audience}.`] : [])
      ],
      hosting:
        input.format === "image" || input.format === "url"
          ? "Host the assets yourself and pass the public URLs as variants, " +
            "or use upload_image on a deployment with asset hosting."
          : "Inline content travels inside the config, so keep it short. " +
            "Anything substantial should be a hosted URL instead.",
      nextStep:
        "Draft the variants against this, then call build_test with them to " +
        "get the URLs and the stats secret."
    };
  }
});

// ---------------------------------------------------------------------------

export const uploadImage = defineTool({
  name: "upload_image",
  title: "Upload an image",
  summary: "Store an image and get back a protected URL to use as a variant",
  description:
    "Uploads an image to the deployment's asset store and returns its URL, " +
    "for use as a variant's `image` (email tests) or `url`.\n\n" +
    "The returned URL is deliberately not fetchable on its own: assets are " +
    "only served with a short-lived signature that the serve endpoints mint " +
    "per request, so uploading here does not create free static hosting. " +
    "Use `previewUrl` (valid for an hour) to check what was stored.\n\n" +
    "Storage is content-addressed: the id is the sha256 of the bytes, so " +
    "uploading the same image twice is harmless and returns the same URL. " +
    "Raster images only; SVG is refused because it can carry scripts. Not " +
    "every deployment enables asset hosting, and this tool says so plainly " +
    "when yours does not.",
  readOnly: false,
  reachesNetwork: true,
  input: z.object({
    data: z
      .string()
      .min(1)
      .max(8_000_000)
      .describe(
        "The image bytes, base64-encoded (plain base64, not a data: URL)."
      ),
    contentType: z
      .enum([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif"
      ])
      .describe(
        "The image's actual type; the server stores and serves it as this."
      ),
    serverUrl: z
      .string()
      .url()
      .optional()
      .describe("Self-hosted deployments only."),
    uploadToken: z
      .string()
      .optional()
      .describe(
        "Only for deployments that gate uploads with LV_ASSET_UPLOAD_TOKEN."
      )
  }),
  output: z.object({
    assetId: z.string().describe("sha256 of the bytes; the id inside the URL."),
    url: z
      .string()
      .describe(
        "Use this as the variant's image/url. 403s without a signature, by design."
      ),
    previewUrl: z
      .string()
      .describe("Signed for one hour, to verify the upload."),
    size: z.number(),
    contentType: z.string()
  }),
  async handler(input, context) {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(input.data.replace(/\s/g, "")), c =>
        c.charCodeAt(0)
      );
    } catch {
      throw new ToolInputError(
        "data is not valid base64 (send plain base64, not a data: URL)"
      );
    }
    const origin = originOf(context, input.serverUrl);
    const response = await context.fetch(`${origin}/assets`, {
      method: "POST",
      headers: {
        "content-type": input.contentType,
        ...(input.uploadToken
          ? { authorization: `Bearer ${input.uploadToken}` }
          : {})
      },
      body: bytes as unknown as BodyInit
    });
    if (response.status === 404) {
      throw new ToolInputError(
        `${origin} does not have asset hosting enabled; host the image ` +
          "yourself and pass its public URL to build_test instead",
        404
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ToolInputError(
        body?.error ?? `upload failed (${response.status})`,
        response.status === 401
          ? 401
          : response.status === 413 || response.status === 415
            ? 400
            : 502
      );
    }
    return (await response.json()) as {
      assetId: string;
      url: string;
      previewUrl: string;
      size: number;
      contentType: string;
    };
  }
});

// ---------------------------------------------------------------------------

const listTests = defineTool({
  name: "list_tests",
  title: "List my tests",
  summary: "Lists the tests saved to the caller's account, with search.",
  description:
    "Lists tests registered to the signed-in account, newest first, with " +
    "cursor pagination and an optional case-insensitive name filter. Only " +
    "exists on deployments with accounts, and only answers for an " +
    "identified caller: unlike every other tool, WHOSE tests these are " +
    "cannot be expressed as an argument. Each entry carries the encoded " +
    "config, which inspect_test and get_stats accept directly.",
  input: z.object({
    q: z
      .string()
      .max(200)
      .optional()
      .describe("Case-insensitive substring filter on the test name"),
    cursor: z
      .string()
      .optional()
      .describe("Opaque cursor from a previous page's nextCursor"),
    limit: z.number().int().min(1).max(100).optional()
  }),
  output: z.object({
    tests: z.array(
      z.object({
        testId: z.string(),
        name: z.string().nullable(),
        encoded: z.string().nullable(),
        region: z.string().nullable(),
        addedAt: z.number()
      })
    ),
    nextCursor: z.string().nullable()
  }),
  readOnly: true,
  reachesNetwork: false,
  scope: "account",
  handler: async (input, context) => {
    if (!context.accounts) {
      throw new ToolInputError(
        "this deployment has no accounts, so there is no test list to read",
        404
      );
    }
    return context.accounts.listTests(input);
  }
});

const registerTestTool = defineTool({
  name: "register_test",
  title: "Register a test to an account",
  summary: "Puts an existing test under an organization's My tests",
  description:
    "Registers a test you built earlier to the organization a publishable " +
    "key belongs to, so it shows under My tests and its stats are readable " +
    "from the dashboard without the secret.\n\n" +
    "Authority is the STATS SECRET: its hash is inside the config, so " +
    "presenting it proves you created (or were entrusted with) the test. " +
    "The publishable key is public and only names the org; alone it grants " +
    "nothing, which is why it is safe for a user to paste into chat. " +
    "Prefer passing publishableKey to build_test directly: it registers at " +
    "creation in one step. Keyless tests cannot be registered this way " +
    "(nothing to prove with); they register through the tag on a verified " +
    "domain. Because the key is public, an org's list is publicly " +
    "writable by design, and the org can always remove a listing from " +
    "its dashboard (the test itself keeps serving).",
  readOnly: false,
  reachesNetwork: true,
  scope: "account",
  input: z.object({
    config: z
      .string()
      .min(1)
      .describe("The encoded test config (from build_test or any test URL)."),
    statsSecret: z
      .string()
      .min(1)
      .describe("The test's stats secret, exactly as build_test returned it."),
    publishableKey: z
      .string()
      .regex(/^pk_[a-z0-9]{24}$/)
      .describe("The target organization's publishable key (pk_..., public).")
  }),
  output: z.object({
    registered: z.literal(true),
    org: z.string().describe("The organization that now owns the test."),
    testId: z.string()
  }),
  async handler(input, context) {
    if (!context.accounts?.registerWithSecret) {
      throw new ToolInputError(
        "this deployment has no accounts to register into",
        404
      );
    }
    const result = await context.accounts.registerWithSecret({
      encoded: input.config,
      statsSecret: input.statsSecret,
      publishableKey: input.publishableKey
    });
    if (!result.ok) {
      switch (result.reason) {
        case "bad-secret":
          throw new ToolInputError(
            "the stats secret does not match this test",
            401
          );
        case "unknown-key":
          throw new ToolInputError(
            "no organization matches that publishable key here",
            404
          );
        case "claimed-elsewhere":
          throw new ToolInputError(
            "this test's stats key is already claimed by another organization",
            409
          );
        default:
          throw new ToolInputError(
            "that config cannot be registered: keyless tests register " +
              "through the tag on a verified domain",
            400
          );
      }
    }
    return {
      registered: true as const,
      org: result.org,
      testId: result.testId
    };
  }
});

export const getTestStatus = defineTool({
  name: "get_test_status",
  title: "Check a test's account and domain status",
  summary:
    "Is the test claimed, and will its destinations show the interstitial",
  description:
    "Reports what the deployment's registry knows about a test: whether it " +
    "is claimed into an account (and by which organization), and whether " +
    "each redirect destination is a verified domain.\n\n" +
    "Unverified destinations work, but visitors see a 'Redirecting you " +
    "to…' continue screen first. When you see verified: false, tell the " +
    "user to verify the domain under Settings on the dashboard; the three " +
    "ways are a DNS TXT record, serving the well-known file, or having " +
    "the SDK tag with their publishable key live in the site's source. " +
    "If the test is unclaimed, remind them the manage URL claims it in " +
    "one click when opened signed in.\n\n" +
    "Authority is the stats secret, same as get_stats: holding it proves " +
    "you administer the test. A manage URL's #fragment is used " +
    "automatically.",
  readOnly: true,
  reachesNetwork: true,
  scope: "account",
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
    claimed: z
      .boolean()
      .describe("Whether the test is registered to an organization."),
    org: z
      .string()
      .nullable()
      .describe("The claiming organization's name; null when unclaimed."),
    destinations: z
      .array(z.object({ host: z.string(), verified: z.boolean() }))
      .describe(
        "Every host this test can redirect a visitor to. verified: false " +
          "means the continue screen shows before landing there."
      )
  }),
  async handler(input, context) {
    if (!context.accounts?.testStatus) {
      throw new ToolInputError(
        "this deployment has no account registry to consult",
        404
      );
    }
    const resolved = await resolveTest(input.test);
    const secret = input.statsSecret ?? resolved.statsSecret;
    if (!secret) {
      throw new ToolInputError(
        "no stats secret: pass statsSecret, or the manage URL whose " +
          "#fragment holds it"
      );
    }
    let encodedConfig: string;
    try {
      encodedConfig = (await encodeConfig(resolved.config)).encoded;
    } catch {
      throw new ToolInputError("that test will not encode");
    }
    const status = await context.accounts.testStatus({
      encoded: encodedConfig,
      statsSecret: secret
    });
    if (!status.ok) {
      throw new ToolInputError(
        status.reason === "bad-secret"
          ? "the stats secret does not match this test"
          : "keyless tests have no secret to prove with, so their status " +
              "is not readable this way",
        status.reason === "bad-secret" ? 401 : 400
      );
    }
    return {
      testId: status.testId,
      claimed: status.claimed,
      org: status.org?.name ?? null,
      destinations: status.destinations
    };
  }
});

/** Every tool, in the order a person meets them. */
export const TOOLS = [
  buildTest,
  inspectTest,
  generatePriors,
  getStats,
  getTestStatus,
  listTests,
  registerTestTool,
  uploadImage,
  variantBrief
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export function findTool(name: string) {
  return TOOLS.find(tool => tool.name === name);
}

/** Soft ceiling worth surfacing in docs alongside the tools. */
export const CONFIG_URL_SOFT_LIMIT = CONFIG_SOFT_LIMIT;
