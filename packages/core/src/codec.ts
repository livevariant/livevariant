import {
  base64UrlToUtf8,
  canonicalJson,
  sha256Hex,
  utf8ToBase64Url
} from "./canonical.js";
import {
  parseTestConfig,
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
export const IDENTITY_EXCLUDED = [
  // Tuning, not identity: the model rebuilds from the event log, so these
  // can change mid-test without resetting history.
  "priors",
  "priorStrengthCap",
  "decorateRedirects",
  // Delivery details, not the test: turning the variant stamp on or
  // switching param forwarding off mid-campaign must not reset history.
  "variantParam",
  "forwardParams"
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
  const config = parseTestConfig(input);
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
  if (!config.statsKeyHash) {
    warnings.push(
      "no statsKeyHash: this test will serve and learn, but its results " +
        "can never be read, because no secret can match a hash that is " +
        "not there"
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
  const config = parseTestConfig(parsed);
  return { config, testId: await computeTestId(config) };
}
