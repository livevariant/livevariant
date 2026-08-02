import { z } from "zod";

/**
 * The test config IS the test: it travels base64url-encoded in serve URLs
 * and its canonical hash (minus tuning fields, see codec.ts) is the test's
 * identity. Keep this schema lean; every byte rides along on every request.
 */

/**
 * http(s) only. Plain z.url() accepts javascript:, data:, and mailto:,
 * which would hand an XSS payload to any SDK consumer assigning
 * variant.url to an href (and opaque schemes all report origin "null",
 * which would collapse the click-redirect origin allowlist).
 */
const httpUrl = z.url({ protocol: /^https?$/ });

const armFormatsSchema = z
  .object({
    /** Destination page for redirect-mode serving (landing page tests). */
    url: httpUrl.optional(),
    /** Image asset URL, for email hero images etc. */
    image: httpUrl.optional(),
    html: z.string().optional(),
    md: z.string().optional(),
    text: z.string().optional()
  })
  .refine(f => Object.values(f).some(v => v !== undefined), {
    message: "arm must define at least one format"
  });

const armSchema = z.object({
  name: z.string().min(1),
  formats: armFormatsSchema,
  /** Overrides the test-level redirectUrl for click redirects. */
  redirectUrl: httpUrl.optional()
});

const ctxDimSchema = z.object({
  key: z.string().min(1),
  /** Known values, if enumerable; omitted means free-form (hashed). */
  values: z.array(z.string().min(1)).min(2).optional()
});

/**
 * Pseudo-observations added to the uniform Beta(1,1) prior at sampling
 * time. alpha counts as successes, beta as failures. Capped by
 * priorStrengthCap so a miscalibrated LLM guess is washed out by real data.
 */
const armPriorSchema = z.object({
  alpha: z.number().nonnegative(),
  beta: z.number().nonnegative()
});

const priorsSchema = z.object({
  /** Global per-arm pseudo-counts (same order as arms). */
  arms: z.array(armPriorSchema).optional(),
  /** Context-specific pseudo-counts, matched by exact ctx values. */
  buckets: z
    .array(
      z.object({
        ctx: z.record(z.string(), z.string()),
        arms: z.array(armPriorSchema)
      })
    )
    .optional(),
  /**
   * Linear-bandit priors: expected reward rate per arm plus a strength in
   * pseudo-observations. Baked into the model's initial state (a change
   * here needs a recompute, unlike arms/buckets priors which apply at
   * sampling time).
   */
  linear: z
    .array(
      z.object({
        mean: z.number().min(0).max(1),
        strength: z.number().nonnegative()
      })
    )
    .optional()
});

export const testConfigSchema = z
  .object({
    v: z.literal(1),
    name: z.string().optional(),
    arms: z.array(armSchema).min(2),
    alg: z.enum(["ts", "bucketed", "linear"]).default("ts"),
    ctx: z.object({ dims: z.array(ctxDimSchema).min(1) }).optional(),
    priors: priorsSchema.optional(),
    /** Max pseudo-observations any prior may contribute per arm. */
    priorStrengthCap: z.number().positive().default(50),
    /** Fallback click-redirect target when the arm has none. */
    redirectUrl: httpUrl.optional(),
    /** GA4 event names the SDK auto-rewards on (dataLayer interception). */
    rewardEvents: z.array(z.string().min(1)).optional(),
    /** Bucketed alg: bucket pulls needed before leaving global fallback. */
    minBucketPulls: z.number().int().positive().default(100),
    /**
     * Append _lvt/_lvid/_lvvar to redirect destinations so an SDK on the
     * destination site can adopt the assignment (identity handoff).
     */
    decorateRedirects: z.boolean().default(true),
    /** sha256 hex of the creator-held stats secret. */
    statsKeyHash: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .superRefine((config, issues) => {
    const armCount = config.arms.length;
    for (const [field, priorArms] of [
      ["arms", config.priors?.arms],
      ["linear", config.priors?.linear]
    ] as const) {
      if (priorArms && priorArms.length !== armCount) {
        issues.addIssue({
          code: "custom",
          path: ["priors", field],
          message: `priors.${field} must have one entry per arm (${armCount})`
        });
      }
    }
    for (const [i, bucket] of (config.priors?.buckets ?? []).entries()) {
      if (bucket.arms.length !== armCount) {
        issues.addIssue({
          code: "custom",
          path: ["priors", "buckets", i, "arms"],
          message: `bucket priors must have one entry per arm (${armCount})`
        });
      }
    }
    if ((config.alg === "bucketed" || config.alg === "linear") && !config.ctx) {
      issues.addIssue({
        code: "custom",
        path: ["ctx"],
        message: `alg "${config.alg}" requires a ctx definition`
      });
    }
  });

export type TestConfig = z.infer<typeof testConfigSchema>;
export type TestConfigInput = z.input<typeof testConfigSchema>;
export type Arm = TestConfig["arms"][number];
export type ArmPrior = z.infer<typeof armPriorSchema>;
export type Priors = z.infer<typeof priorsSchema>;
