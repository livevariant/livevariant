import * as z from "zod/mini";
import { cellCount, MAX_CELLS } from "./cells.js";
import { AUTO_SIGNALS, TEST_REGIONS } from "./signals.js";

/**
 * The test config, version 2: slots-native. A test is one or more SLOTS
 * (page or email elements), each with variants; the test optimizes the
 * combination. A classic A/B test is simply one slot.
 *
 * There is deliberately no algorithm field, no bucket tuning, nothing to
 * choose: every test runs the same joint linear Thompson sampling model
 * (model.ts), sized and configured from this shape. Users describe what
 * to test; the mathematics is our job.
 *
 * Configs are written to be READ. The canonical wire form is still the
 * encoded URL, but authoring happens as the plain object below, with
 * shorthands where they help: a variant can be a bare string (a URL
 * becomes its destination, anything else its text), and a single-slot
 * test can say `variants` instead of `slots`.
 */

/**
 * http(s) only. Plain z.url() accepts javascript:, data:, and mailto:,
 * which would hand an XSS payload to any SDK consumer assigning
 * variant.url to an href (and opaque schemes all report origin "null",
 * which would collapse the click-redirect origin allowlist).
 */
const httpUrl = z.url({ protocol: /^https?$/ });

const variantObject = z
  .object({
    /** Shown in stats and utm stamps. Defaults to v1, v2, ... per slot. */
    name: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
    /** Destination page for redirect-mode serving. */
    url: z.optional(httpUrl),
    /** Image asset URL, for email variants (hosted assets land here). */
    image: z.optional(httpUrl),
    /** Inline content, served by the SDK. */
    html: z.optional(z.string()),
    md: z.optional(z.string()),
    text: z.optional(z.string()),
    /** Where a click on this variant lands, when it differs per variant. */
    redirectUrl: z.optional(httpUrl)
  })
  .check(
    z.refine(
      v =>
        v.url !== undefined ||
        v.image !== undefined ||
        v.html !== undefined ||
        v.md !== undefined ||
        v.text !== undefined,
      { message: "variant must define url, image, html, md or text" }
    )
  );

/**
 * A bare string is the most readable spelling of the common cases:
 * "https://..." is a destination, anything else is text content.
 */
const variantSchema = z.pipe(
  z.transform(value => {
    if (typeof value === "string") {
      return /^https?:\/\//i.test(value) ? { url: value } : { text: value };
    }
    return value;
  }),
  variantObject
);

const SLOT_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

export const ctxDimSchema = z
  .object({
    key: z.string().check(z.minLength(1)),
    /** Known values, if enumerable; omitted means free-form (hashed). */
    values: z.optional(
      z.array(z.string().check(z.minLength(1))).check(z.minLength(2))
    ),
    /**
     * Fill this dimension from a signal the server derives, so the caller
     * never has to pass it (country, device, utm_source, ...). A supplied
     * `c_<key>` still wins: you know your own users better than an IP
     * database does.
     */
    from: z.optional(z.enum(AUTO_SIGNALS)),
    /**
     * Fill this dimension by asking the DEPLOYMENT, naming one of the
     * resolvers it was configured with. For buckets that are not a signal
     * but a lookup: a postcode becomes a segment, an account id becomes a
     * plan tier, and the thing that knows is a service, not this request.
     *
     * The resolver reads the caller's raw context, so its INPUT need not
     * be a dimension at all, and only its answer is ever hashed or
     * stored. A `values` list still binds, so a resolver cannot invent
     * buckets the config never sanctioned.
     *
     * Server-side only: /choose carries a context hash computed on the
     * page precisely so raw values never leave it, so a page that wants a
     * resolved dimension resolves it there and passes the result.
     */
    resolve: z.optional(z.string().check(z.regex(/^[a-z][a-z0-9-]{0,31}$/)))
  })
  .check(
    z.refine(dim => !(dim.from && dim.resolve), {
      message:
        "a context dimension is filled from a signal or a resolver, not both"
    })
  );

/**
 * Warm-start prior for one variant, typically an LLM's guess: "this will
 * convert around `mean`, and I am `strength` observations sure". Capped by
 * priorStrengthCap so a confident wrong guess costs a little early
 * traffic, never the test.
 */
const variantPriorSchema = z.object({
  mean: z.number().check(z.minimum(0), z.maximum(1)),
  strength: z.number().check(z.nonnegative())
});

const configObject = z
  .object({
    v: z._default(z.literal(2), 2),
    name: z.optional(z.string()),
    /**
     * The elements under test, keyed by a stable name ("hero", "cta").
     * Canonical slot order is the SORTED key order: canonical JSON sorts
     * keys, and cell indices must survive serialization.
     */
    slots: z.record(
      z.string().check(z.regex(SLOT_KEY)),
      z.array(variantSchema).check(z.minLength(1))
    ),
    ctx: z.optional(
      z.object({ dims: z.array(ctxDimSchema).check(z.minLength(1)) })
    ),
    /**
     * Per-slot warm-start priors, one entry per variant.
     * Identity-excluded: adding or changing them keeps the test's id and
     * its history (a recompute rebuilds the model).
     */
    priors: z.optional(z.record(z.string(), z.array(variantPriorSchema))),
    /**
     * Priors that hold only inside one context bucket: "for the blue
     * segment, image B is the one". `priors` above cannot say that, because
     * it writes to a variant's MAIN effect, which is the belief about that
     * variant for everybody; a belief about one segment lives on the
     * (context x variant) interaction, and this is what writes to it.
     *
     * Each block carries the same positional per-slot shape as `priors`, so
     * one block reads as a whole opinion about one segment. Identity-
     * excluded exactly like `priors`.
     */
    ctxPriors: z.optional(
      z.array(
        z.object({
          /** Dimension key to value, as declared under `ctx.dims`. */
          when: z.record(z.string(), z.string()),
          priors: z.record(z.string(), z.array(variantPriorSchema))
        })
      )
    ),
    /** Max pseudo-observations any prior may contribute per variant. */
    priorStrengthCap: z._default(z.number().check(z.positive()), 50),
    /**
     * Where the test's state lives. A location hint (wnam, enam, sam,
     * weur, eeur, apac, oc, afr, me) places the test's storage near its
     * audience; "eu" is the EU JURISDICTION, guaranteeing the state is
     * created and kept inside the EU. Without it, state is created
     * wherever the FIRST request came from, and in email that is
     * routinely a mail provider's US datacenter fetching images for a
     * European audience.
     *
     * Deliberately part of the test's identity: moving state is
     * physically a different object, and a tampered region on a public
     * URL must self-isolate as a different test rather than split one
     * test's records across two homes.
     */
    region: z.optional(z.enum(TEST_REGIONS)),
    /**
     * Identity namespace. Two sites inlining the same trivial config
     * ("Book" vs "Book now") would otherwise hash to the SAME test and
     * pollute each other's results: the config is the identity, and
     * identical configs are identical tests. Tests built with a stats
     * key are already unique (the key hash is random and inside the
     * identity), so scope matters for keyless inline configs, and the
     * SDK defaults it to the page's hostname for exactly those. Set it
     * explicitly to share one test across domains.
     */
    scope: z.optional(z.string().check(z.minLength(1), z.maxLength(120))),
    /** Fallback click-redirect target when neither slot nor variant has one. */
    redirectUrl: z.optional(httpUrl),
    /**
     * Per-slot click destination, for a multi-element test whose elements
     * point at different pages: a hero image leading to the campaign
     * landing page while the CTA below it leads to the pricing page.
     *
     * Sits between the two destinations that already existed, so the full
     * precedence is: an explicit `?to=`, then the variant's own
     * `redirectUrl`, then this, then the config-level `redirectUrl`. The
     * common test still names ONE destination and says nothing here.
     *
     * Identity-included like every other destination: a click link that
     * disagreed with the image links about where clicks go would reward a
     * different test than the one being served.
     */
    slotRedirects: z.optional(
      z.record(z.string().check(z.regex(SLOT_KEY)), httpUrl)
    ),
    /** GA4 event names the SDK auto-rewards on (dataLayer interception). */
    rewardEvents: z.optional(z.array(z.string().check(z.minLength(1)))),
    /**
     * Append _lvt/_lvid/_lvvar to redirect destinations so an SDK on the
     * destination site can adopt the assignment (identity handoff).
     */
    decorateRedirects: z._default(z.boolean(), true),
    /**
     * Stamp the served combination into this query parameter on redirect,
     * e.g. "utm_content", so the test shows up in the customer's own
     * analytics without them installing anything.
     */
    variantParam: z.optional(z.string().check(z.minLength(1), z.maxLength(32))),
    /**
     * Carry query parameters we do not recognize onto the redirect
     * target, so utm_source and friends survive the hop.
     */
    forwardParams: z._default(z.boolean(), true),
    /**
     * sha256 hex of the creator-held stats secret. Optional so a
     * variants-only query URL parses, but a test without one has no
     * readable stats, ever: no secret can match a hash that is not there.
     */
    statsKeyHash: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/)))
  })
  .check(ctx => {
    const config = ctx.value;
    const sizes = Object.entries(config.slots)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, variants]) => variants.length);
    const cells = cellCount(sizes);
    if (cells < 2) {
      ctx.issues.push({
        code: "custom",
        path: ["slots"],
        input: config.slots,
        message: "a test needs at least two combinations to choose between"
      });
    }
    if (cells > MAX_CELLS) {
      ctx.issues.push({
        code: "custom",
        path: ["slots"],
        input: config.slots,
        message:
          `${cells} combinations exceeds the ${MAX_CELLS}-cell limit; use ` +
          "fewer variants per slot, or split into composed tests"
      });
    }
    for (const slotKey of Object.keys(config.slotRedirects ?? {})) {
      if (!config.slots[slotKey]) {
        ctx.issues.push({
          code: "custom",
          path: ["slotRedirects", slotKey],
          input: config.slotRedirects,
          message:
            `slotRedirects name a slot that does not exist ` +
            `(have: ${Object.keys(config.slots).join(", ")})`
        });
      }
    }
    checkPriorSlots(ctx, config, config.priors, ["priors"]);
    const dims = new Map((config.ctx?.dims ?? []).map(d => [d.key, d.values]));
    for (let i = 0; i < (config.ctxPriors ?? []).length; i++) {
      const block = config.ctxPriors![i];
      checkPriorSlots(ctx, config, block.priors, ["ctxPriors", i, "priors"]);
      const conditions = Object.entries(block.when);
      if (conditions.length === 0) {
        ctx.issues.push({
          code: "custom",
          path: ["ctxPriors", i, "when"],
          input: block.when,
          message:
            "a conditioned prior needs a condition; an unconditioned " +
            "belief belongs in `priors`"
        });
      }
      for (const [key, value] of conditions) {
        if (!dims.has(key)) {
          ctx.issues.push({
            code: "custom",
            path: ["ctxPriors", i, "when", key],
            input: block.when,
            message:
              `"${key}" is not a declared context dimension ` +
              `(have: ${[...dims.keys()].join(", ") || "none"})`
          });
          continue;
        }
        const allowed = dims.get(key);
        // A prior on a value the dimension can never take would sit on a
        // feature no request ever activates: dead weight that reads as a
        // configured belief.
        if (allowed && !allowed.includes(value)) {
          ctx.issues.push({
            code: "custom",
            path: ["ctxPriors", i, "when", key],
            input: block.when,
            message:
              `"${value}" is not one of the declared values for "${key}" ` +
              `(have: ${allowed.join(", ")})`
          });
        }
      }
    }
  });

/** The rule both prior shapes share: name a real slot, one entry per variant. */
function checkPriorSlots(
  ctx: { issues: Record<string, unknown>[] },
  config: { slots: Record<string, unknown[]> },
  priors: Record<string, unknown[]> | undefined,
  path: (string | number)[]
): void {
  for (const [slotKey, entries] of Object.entries(priors ?? {})) {
    const variants = config.slots[slotKey];
    if (!variants) {
      ctx.issues.push({
        code: "custom",
        path: [...path, slotKey],
        input: priors,
        message:
          `priors name a slot that does not exist ` +
          `(have: ${Object.keys(config.slots).join(", ")})`
      });
    } else if (entries.length !== variants.length) {
      ctx.issues.push({
        code: "custom",
        path: [...path, slotKey],
        input: priors,
        message:
          `slot "${slotKey}" has ${variants.length} variants ` +
          `but ${entries.length} priors`
      });
    }
  }
}

export const testConfigSchema = z.pipe(
  z.transform(value => {
    // Single-slot sugar: `variants: [...]` reads better than a one-entry
    // slots record, and most tests are single-slot.
    if (
      value !== null &&
      typeof value === "object" &&
      "variants" in value &&
      !("slots" in value)
    ) {
      const { variants, ...rest } = value as Record<string, unknown>;
      return { ...rest, slots: { main: variants } };
    }
    return value;
  }),
  configObject
);

/**
 * Parse and normalize a config. The one place that knows which zod
 * flavour builds these schemas: core is bundled into the browser tag, so
 * it uses zod/mini, whose functional API means `schema.parse(x)` does not
 * exist. Callers say what they mean and stay out of it.
 */
export function parseTestConfig(input: unknown): TestConfig {
  return z.parse(testConfigSchema, input) as TestConfig;
}

/** Non-throwing sibling, for callers that report their own errors. */
export function safeParseTestConfig(
  input: unknown
): { success: true; data: TestConfig } | { success: false; error: Error } {
  const result = z.safeParse(testConfigSchema, input);
  return result.success
    ? { success: true, data: result.data as TestConfig }
    : { success: false, error: result.error };
}

export type TestConfig = z.output<typeof configObject>;
export type TestConfigInput =
  | z.input<typeof configObject>
  | (Omit<z.input<typeof configObject>, "slots"> & {
      slots?: never;
      variants: z.input<typeof configObject>["slots"][string];
    });
export type Variant = TestConfig["slots"][string][number];
export type CtxDim = z.infer<typeof ctxDimSchema>;
export type VariantPriorInput = z.infer<typeof variantPriorSchema>;

/**
 * The slots in canonical order: sorted by key. Cell indices are defined
 * against this order, and canonical JSON sorts keys, so the order
 * survives every serialization round-trip.
 */
export function slotEntries(config: TestConfig): Array<[string, Variant[]]> {
  return Object.entries(config.slots).sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Variant counts per slot, canonical order. */
export function slotSizes(config: TestConfig): number[] {
  return slotEntries(config).map(([, variants]) => variants.length);
}

/**
 * Where a click on one variant lands: the single place that knows the
 * precedence, so the click route, the trust check and every tool answer
 * the question the same way.
 *
 * `to` wins because it is the caller being explicit, then the variant,
 * then its slot, then the test. Undefined means the click has nowhere to
 * go, which is a 400 rather than a guess.
 */
export function clickTarget(
  config: TestConfig,
  slotKey: string,
  variant: Variant | undefined,
  to?: string
): string | undefined {
  return (
    to ??
    variant?.redirectUrl ??
    config.slotRedirects?.[slotKey] ??
    config.redirectUrl
  );
}

/**
 * Whether any click destination in this test depends on WHICH element was
 * clicked. When nothing does, one slot-less click link can wrap every
 * element of a multi-slot email; when something does, each click link has
 * to name its slot.
 */
export function hasPerElementDestinations(config: TestConfig): boolean {
  if (Object.keys(config.slotRedirects ?? {}).length > 0) {
    return true;
  }
  return Object.values(config.slots).some(variants =>
    variants.some(variant => variant.redirectUrl !== undefined)
  );
}

/** Every URL a config can send a visitor to, for trust checks. */
export function destinationUrls(config: TestConfig): string[] {
  const urls: string[] = [];
  for (const variants of Object.values(config.slots)) {
    for (const variant of variants) {
      urls.push(
        variant.url ?? "",
        variant.image ?? "",
        variant.redirectUrl ?? ""
      );
    }
  }
  urls.push(...Object.values(config.slotRedirects ?? {}));
  urls.push(config.redirectUrl ?? "");
  return urls.filter(Boolean);
}

/** A variant's display name, defaulting per slot to v1, v2, ... */
export function variantName(variant: Variant, index: number): string {
  return variant.name?.trim() || `v${index + 1}`;
}

/** Per-slot variant names for one choice, e.g. { cta: "v1", hero: "b" }. */
export function cellNames(
  config: TestConfig,
  choice: number[]
): Record<string, string> {
  const entries = slotEntries(config);
  const names: Record<string, string> = {};
  for (let i = 0; i < entries.length; i++) {
    const [key, variants] = entries[i];
    names[key] = variantName(variants[choice[i]], choice[i]);
  }
  return names;
}
