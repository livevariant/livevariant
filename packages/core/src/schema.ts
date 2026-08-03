import { z } from "zod";
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
    name: z.string().min(1).max(64).optional(),
    /** Destination page for redirect-mode serving. */
    url: httpUrl.optional(),
    /** Image asset URL, for email variants (hosted assets land here). */
    image: httpUrl.optional(),
    /** Inline content, served by the SDK. */
    html: z.string().optional(),
    md: z.string().optional(),
    text: z.string().optional(),
    /** Where a click on this variant lands, when it differs per variant. */
    redirectUrl: httpUrl.optional()
  })
  .refine(
    v =>
      v.url !== undefined ||
      v.image !== undefined ||
      v.html !== undefined ||
      v.md !== undefined ||
      v.text !== undefined,
    { message: "variant must define url, image, html, md or text" }
  );

/**
 * A bare string is the most readable spelling of the common cases:
 * "https://..." is a destination, anything else is text content.
 */
const variantSchema = z.preprocess(value => {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? { url: value } : { text: value };
  }
  return value;
}, variantObject);

const SLOT_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

export const ctxDimSchema = z.object({
  key: z.string().min(1),
  /** Known values, if enumerable; omitted means free-form (hashed). */
  values: z.array(z.string().min(1)).min(2).optional(),
  /**
   * Fill this dimension from a signal the server derives, so the caller
   * never has to pass it (country, device, utm_source, ...). A supplied
   * `c_<key>` still wins: you know your own users better than an IP
   * database does.
   */
  from: z.enum(AUTO_SIGNALS).optional()
});

/**
 * Warm-start prior for one variant, typically an LLM's guess: "this will
 * convert around `mean`, and I am `strength` observations sure". Capped by
 * priorStrengthCap so a confident wrong guess costs a little early
 * traffic, never the test.
 */
const variantPriorSchema = z.object({
  mean: z.number().min(0).max(1),
  strength: z.number().nonnegative()
});

const configObject = z
  .object({
    v: z.literal(2).default(2),
    name: z.string().optional(),
    /**
     * The elements under test, keyed by a stable name ("hero", "cta").
     * Canonical slot order is the SORTED key order: canonical JSON sorts
     * keys, and cell indices must survive serialization.
     */
    slots: z.record(z.string().regex(SLOT_KEY), z.array(variantSchema).min(1)),
    ctx: z.object({ dims: z.array(ctxDimSchema).min(1) }).optional(),
    /**
     * Per-slot warm-start priors, one entry per variant.
     * Identity-excluded: adding or changing them keeps the test's id and
     * its history (a recompute rebuilds the model).
     */
    priors: z.record(z.string(), z.array(variantPriorSchema)).optional(),
    /** Max pseudo-observations any prior may contribute per variant. */
    priorStrengthCap: z.number().positive().default(50),
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
    region: z.enum(TEST_REGIONS).optional(),
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
    scope: z.string().min(1).max(120).optional(),
    /** Fallback click-redirect target when the variant has none. */
    redirectUrl: httpUrl.optional(),
    /** GA4 event names the SDK auto-rewards on (dataLayer interception). */
    rewardEvents: z.array(z.string().min(1)).optional(),
    /**
     * Append _lvt/_lvid/_lvvar to redirect destinations so an SDK on the
     * destination site can adopt the assignment (identity handoff).
     */
    decorateRedirects: z.boolean().default(true),
    /**
     * Stamp the served combination into this query parameter on redirect,
     * e.g. "utm_content", so the test shows up in the customer's own
     * analytics without them installing anything.
     */
    variantParam: z.string().min(1).max(32).optional(),
    /**
     * Carry query parameters we do not recognize onto the redirect
     * target, so utm_source and friends survive the hop.
     */
    forwardParams: z.boolean().default(true),
    /**
     * sha256 hex of the creator-held stats secret. Optional so a
     * variants-only query URL parses, but a test without one has no
     * readable stats, ever: no secret can match a hash that is not there.
     */
    statsKeyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
  })
  .superRefine((config, issues) => {
    const sizes = Object.entries(config.slots)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, variants]) => variants.length);
    const cells = cellCount(sizes);
    if (cells < 2) {
      issues.addIssue({
        code: "custom",
        path: ["slots"],
        message: "a test needs at least two combinations to choose between"
      });
    }
    if (cells > MAX_CELLS) {
      issues.addIssue({
        code: "custom",
        path: ["slots"],
        message:
          `${cells} combinations exceeds the ${MAX_CELLS}-cell limit; use ` +
          "fewer variants per slot, or split into composed tests"
      });
    }
    for (const [slotKey, priors] of Object.entries(config.priors ?? {})) {
      const variants = config.slots[slotKey];
      if (!variants) {
        issues.addIssue({
          code: "custom",
          path: ["priors", slotKey],
          message:
            `priors name a slot that does not exist ` +
            `(have: ${Object.keys(config.slots).join(", ")})`
        });
      } else if (priors.length !== variants.length) {
        issues.addIssue({
          code: "custom",
          path: ["priors", slotKey],
          message:
            `slot "${slotKey}" has ${variants.length} variants ` +
            `but ${priors.length} priors`
        });
      }
    }
  });

export const testConfigSchema = z.preprocess(value => {
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
}, configObject);

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
