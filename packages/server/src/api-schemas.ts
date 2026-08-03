import { z } from "zod";
import { cellCount, ctxDimSchema, MAX_CELLS } from "@livevariant/core";

/**
 * JS-mode request bodies. Deliberately content-free: the SDK sends only
 * hashes, indices, and shape numbers, never variant content or raw ids.
 *
 * The one exception is `autoCtx`, whose values are raw. Those dimensions
 * are the coarse ones the server derives from the request itself anyway
 * (country, device, language), and redirect mode has always taken them as
 * plain `?c_country=` params, so this adds no exposure the product did
 * not already have.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** Shared bound so /px and /reward can never drift apart again. */
export const MAX_REWARD_AMOUNT = 1_000_000;

/**
 * A warm-start prior for one slot variant. The caller supplies both the
 * priors and their cap, so the server clamps strength to its own ceiling
 * before use (see /choose): a hostile prior must not be able to pin a
 * variant.
 */
const variantPrior = z.object({
  slot: z.number().int().min(0).max(15),
  variant: z.number().int().min(0).max(63),
  mean: z.number().min(0).max(1),
  strength: z.number().nonnegative()
});

export const chooseRequestSchema = z
  .object({
    testId: hex64,
    /**
     * Variant counts per slot, canonical (sorted-key) order. The whole
     * serving shape in one array: a plain A/B test is [2].
     */
    slotSizes: z.array(z.number().int().min(1).max(64)).min(1).max(16),
    /** Model dimension; the SDK computes it with core's dimForShape. */
    dim: z.number().int().min(16).max(256),
    priorStrengthCap: z.number().positive().optional(),
    noise: z.number().positive().max(5).optional(),
    idHash: hex64.optional(),
    ctxKey: hex64.optional(),
    /**
     * The config's `from` dimensions, forwarded so the server can fill
     * them the same way it does for redirects. JS mode never sends the
     * config, and the server cannot read `ctx.dims` without it.
     *
     * That means the `values` allowlist here is the caller's copy, not the
     * authoritative one, so a hand-written client can drop it and mint
     * bucket keys the config never sanctioned. This grants nothing new:
     * `ctxKey` is already an opaque 64-hex string of the caller's
     * choosing, so JS mode has always been able to mint arbitrary buckets,
     * and the redirect path (which does hold the config) still enforces
     * the allowlist. Forged buckets are self-isolating, carry only their
     * own traffic, and show up in the `/stats` bucket list for the
     * creator to quarantine.
     */
    autoDims: z.array(ctxDimSchema).max(8).optional(),
    /** Caller-supplied values for those dimensions, before signals. */
    autoCtx: z.record(z.string().min(1), z.string().min(1).max(64)).optional(),
    /**
     * Hosted-asset hashes per slot variant ("slot:variant" keys), so the
     * response can carry fresh signatures for whichever combination wins.
     * Content-free like everything else on this wire: a sha256 of an
     * image reveals nothing about it, and the config holding the actual
     * URLs never leaves the page.
     */
    assets: z
      .record(
        z.string().regex(/^\d{1,2}:\d{1,2}$/),
        z.array(hex64).min(1).max(8)
      )
      .optional(),
    // Bounds are re-checked against the request's own `dim` in superRefine:
    // an index >= dim reads past the model matrix and poisons it with NaN.
    featIdx: z.array(z.number().int().min(0).max(255)).max(32).optional(),
    priors: z.array(variantPrior).max(128).optional()
  })
  .superRefine((body, issues) => {
    const cells = cellCount(body.slotSizes);
    if (cells < 2 || cells > MAX_CELLS) {
      issues.addIssue({
        code: "custom",
        path: ["slotSizes"],
        message: `slotSizes spans ${cells} combinations; must be 2..${MAX_CELLS}`
      });
    }
    for (const key of Object.keys(body.assets ?? {})) {
      const [slot, variant] = key.split(":").map(Number);
      if (
        slot >= body.slotSizes.length ||
        variant >= (body.slotSizes[slot] ?? 0)
      ) {
        issues.addIssue({
          code: "custom",
          path: ["assets", key],
          message: `"${key}" is outside slotSizes [${body.slotSizes.join(", ")}]`
        });
      }
    }
    for (const [i, index] of (body.featIdx ?? []).entries()) {
      if (index >= body.dim) {
        issues.addIssue({
          code: "custom",
          path: ["featIdx", i],
          message: `feature index ${index} is outside dim ${body.dim}`
        });
      }
    }
    for (const [i, prior] of (body.priors ?? []).entries()) {
      if (
        prior.slot >= body.slotSizes.length ||
        prior.variant >= (body.slotSizes[prior.slot] ?? 0)
      ) {
        issues.addIssue({
          code: "custom",
          path: ["priors", i],
          message:
            `prior (slot ${prior.slot}, variant ${prior.variant}) is ` +
            `outside slotSizes [${body.slotSizes.join(", ")}]`
        });
      }
    }
  });

// Deliberately minimal: the assignment record carries its own serving
// snapshot, so rewards need no shape parameters. This is also what
// keeps the redirect handoff token small (_lvt + _lvid suffice).
export const rewardRequestSchema = z.object({
  testId: hex64,
  idHash: hex64,
  amount: z.number().positive().max(MAX_REWARD_AMOUNT).default(1)
});

export type ChooseRequest = z.infer<typeof chooseRequestSchema>;
export type RewardRequest = z.infer<typeof rewardRequestSchema>;

/** Creator quarantine payload for POST /exclude/:cfg. */
export const excludeRequestSchema = z.object({
  sources: z.array(hex64).max(1000).optional(),
  windows: z
    .array(z.object({ since: z.number().int(), until: z.number().int() }))
    .max(100)
    .optional()
});

export type ExcludeRequest = z.infer<typeof excludeRequestSchema>;
