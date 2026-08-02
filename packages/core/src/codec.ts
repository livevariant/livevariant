import {
  base64UrlToUtf8,
  canonicalJson,
  sha256Hex,
  utf8ToBase64Url
} from "./canonical.js";
import {
  testConfigSchema,
  type TestConfig,
  type TestConfigInput
} from "./schema.js";

/**
 * Fields excluded from the identity hash. These tune HOW the bandit picks,
 * not WHAT is being tested, and state is event-sourced, so they may change
 * mid-test: the server just recomputes derived state from the recorded
 * events. Everything else (arms, ctx, statsKeyHash, rewardEvents, ...) is
 * semantic: changing it derives a fresh test with fresh state, which is
 * also what makes URL tampering self-isolating.
 */
const IDENTITY_EXCLUDED = [
  "alg",
  "priors",
  "priorStrengthCap",
  "minBucketPulls",
  "decorateRedirects"
] as const;

/** Encoded configs beyond this length get a warning (URL ergonomics). */
export const CONFIG_SOFT_LIMIT = 2048;
/** Hard error: at this point inline content must move to a hosted URL. */
export const CONFIG_HARD_LIMIT = 8192;

export async function computeTestId(config: TestConfig): Promise<string> {
  const identity: Record<string, unknown> = { ...config };
  for (const field of IDENTITY_EXCLUDED) {
    delete identity[field];
  }
  return sha256Hex(canonicalJson(identity));
}

export interface EncodedConfig {
  encoded: string;
  testId: string;
  warnings: string[];
}

export async function encodeConfig(
  input: TestConfigInput
): Promise<EncodedConfig> {
  const config = testConfigSchema.parse(input);
  const encoded = utf8ToBase64Url(canonicalJson(config));
  if (encoded.length > CONFIG_HARD_LIMIT) {
    throw new Error(
      `encoded config is ${encoded.length} chars (limit ${CONFIG_HARD_LIMIT}); ` +
        `host large HTML as a URL instead of inlining it`
    );
  }
  const warnings: string[] = [];
  if (encoded.length > CONFIG_SOFT_LIMIT) {
    warnings.push(
      `encoded config is ${encoded.length} chars; some tooling truncates ` +
        `URLs beyond ${CONFIG_SOFT_LIMIT}, consider hosting inline content`
    );
  }
  return { encoded, testId: await computeTestId(config), warnings };
}

export interface DecodedConfig {
  config: TestConfig;
  testId: string;
}

export async function decodeConfig(encoded: string): Promise<DecodedConfig> {
  if (encoded.length > CONFIG_HARD_LIMIT) {
    throw new Error("encoded config exceeds the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlToUtf8(encoded));
  } catch {
    throw new Error("not a valid base64url-encoded config");
  }
  const config = testConfigSchema.parse(parsed);
  return { config, testId: await computeTestId(config) };
}
