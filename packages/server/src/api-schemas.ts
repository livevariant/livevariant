import { z } from "zod";
import { ctxDimSchema } from "@livevariant/core";

/**
 * JS-mode request bodies. Deliberately content-free: the SDK sends only
 * hashes, indices, and tuning numbers, never variant content or raw ids.
 *
 * The one exception is `autoCtx`, whose values are raw. Those dimensions
 * are the coarse ones the server derives from the request itself anyway
 * (country, device, language), and redirect mode has always taken them as
 * plain `?c_country=` params, so this adds no exposure the product did
 * not already have.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const armPrior = z.object({
  alpha: z.number().nonnegative(),
  beta: z.number().nonnegative()
});

/** Shared bound so /px and /reward can never drift apart again. */
export const MAX_REWARD_AMOUNT = 1_000_000;

const servingFields = {
  testId: hex64,
  armCount: z.number().int().min(2).max(50),
  alg: z.enum(["ts", "bucketed", "linear"]),
  dim: z.number().int().min(2).max(64).optional(),
  minBucketPulls: z.number().int().positive().optional(),
  priorStrengthCap: z.number().positive().optional(),
  noise: z.number().positive().max(5).optional()
};

export const chooseRequestSchema = z
  .object({
    ...servingFields,
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
     * Hosted-asset hashes per arm index, so the response can carry fresh
     * signatures for whichever arm wins. Content-free like everything
     * else on this wire: a sha256 of an image reveals nothing about it,
     * and the config holding the actual URLs never leaves the page.
     */
    assets: z
      .record(z.string().regex(/^\d{1,2}$/), z.array(hex64).min(1).max(8))
      .optional(),
    // Bounds are re-checked against the request's own `dim` in superRefine:
    // an index >= dim reads past the model matrix and poisons it with NaN.
    featIdx: z.array(z.number().int().min(0).max(63)).max(16).optional(),
    armPriors: z.array(armPrior).optional(),
    bucketPriors: z.record(hex64, z.array(armPrior)).optional(),
    linearPriors: z
      .array(
        z.object({
          mean: z.number().min(0).max(1),
          strength: z.number().nonnegative()
        })
      )
      .optional()
  })
  .superRefine((body, issues) => {
    for (const key of Object.keys(body.assets ?? {})) {
      if (Number(key) >= body.armCount) {
        issues.addIssue({
          code: "custom",
          path: ["assets", key],
          message: `arm ${key} is outside armCount ${body.armCount}`
        });
      }
    }
    const dim = body.dim ?? 16;
    for (const [i, index] of (body.featIdx ?? []).entries()) {
      if (index >= dim) {
        issues.addIssue({
          code: "custom",
          path: ["featIdx", i],
          message: `feature index ${index} is outside dim ${dim}`
        });
      }
    }
    const priorCounts: Array<[string, number | undefined]> = [
      ["armPriors", body.armPriors?.length],
      ["linearPriors", body.linearPriors?.length]
    ];
    for (const [field, count] of priorCounts) {
      if (count !== undefined && count !== body.armCount) {
        issues.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must have one entry per arm (${body.armCount})`
        });
      }
    }
    // Every bucket's array is an arm-prior list with the same arity rule.
    // A short one leaves the trailing arms on the uniform prior while arm
    // 0 keeps a strong one, which biases selection for that bucket, and
    // bucket keys are derivable by anyone who can see a serve URL.
    for (const [key, priors] of Object.entries(body.bucketPriors ?? {})) {
      if (priors.length !== body.armCount) {
        issues.addIssue({
          code: "custom",
          path: ["bucketPriors", key],
          message: `bucketPriors must have one entry per arm (${body.armCount})`
        });
      }
    }
  });

// Deliberately minimal: the assignment record carries its own serving
// snapshot, so rewards need no algorithm parameters. This is also what
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
