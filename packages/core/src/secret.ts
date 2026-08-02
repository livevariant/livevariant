import { bytesToBase64Url, sha256Hex } from "./canonical.js";

/**
 * The stats secret is the only credential in the system: generated once at
 * config-build time, held by the creator, and only its sha256 lives in the
 * (public) config. Because statsKeyHash is part of the identity hash, a
 * tampered hash yields a different testId with empty state; the secret's
 * authority is structural, no server-side registry needed.
 */

export function generateStatsSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function hashStatsSecret(secret: string): Promise<string> {
  return sha256Hex(secret);
}

export async function verifyStatsSecret(
  secret: string,
  statsKeyHash: string
): Promise<boolean> {
  const actual = await sha256Hex(secret);
  // Constant-time compare; both sides are fixed-length lowercase hex.
  if (actual.length !== statsKeyHash.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ statsKeyHash.charCodeAt(i);
  }
  return diff === 0;
}
