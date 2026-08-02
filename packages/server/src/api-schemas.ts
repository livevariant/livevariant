import { z } from "zod";

/**
 * JS-mode request bodies. Deliberately content-free: the SDK sends only
 * hashes, indices, and tuning numbers, never variant content, raw ids, or
 * raw context values.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const armPrior = z.object({
  alpha: z.number().nonnegative(),
  beta: z.number().nonnegative()
});

const servingFields = {
  testId: hex64,
  armCount: z.number().int().min(2).max(50),
  alg: z.enum(["ts", "bucketed", "linear"]),
  dim: z.number().int().min(2).max(64).optional(),
  minBucketPulls: z.number().int().positive().optional(),
  priorStrengthCap: z.number().positive().optional(),
  noise: z.number().positive().max(5).optional()
};

export const chooseRequestSchema = z.object({
  ...servingFields,
  idHash: hex64.optional(),
  ctxKey: hex64.optional(),
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
});

// Deliberately minimal: the assignment record carries its own serving
// snapshot, so rewards need no algorithm parameters. This is also what
// keeps the redirect handoff token small (_lvt + _lvid suffice).
export const rewardRequestSchema = z.object({
  testId: hex64,
  idHash: hex64,
  amount: z.number().positive().max(1_000_000).default(1)
});

export type ChooseRequest = z.infer<typeof chooseRequestSchema>;
export type RewardRequest = z.infer<typeof rewardRequestSchema>;
