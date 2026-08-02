import { sha256Hex } from "./canonical.js";

/**
 * Source bucketing for robust aggregation. Writes are unauthenticated by
 * design (the config is public), so instead of trying to authenticate
 * every visitor we bound how much any one traffic source can move a
 * test. The bucket is deliberately coarse and deliberately forgettable:
 *
 *   srcHash = sha256(testId | dateUTC | ipPrefix)
 *
 * The raw address is never stored, the hash is scoped to one test and
 * one day (so it is neither a cross-test nor a long-term identifier),
 * and only the creator can ever see it. The honest caveat, which the
 * README states: a creator could brute-force a /24 back out of the hash
 * for their own traffic.
 */

/** IPv4 collapses to its /24, IPv6 to its /48. */
export function ipPrefix(ip: string): string | null {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.includes(":")) {
    const groups = trimmed.split(":");
    // Expand-free /48: the first three groups, empty groups meaning "::".
    const prefix = groups.slice(0, 3).map(g => g || "0");
    return prefix.length === 3 ? `${prefix.join(":")}::/48` : null;
  }
  const octets = trimmed.split(".");
  if (octets.length !== 4 || octets.some(o => !/^\d{1,3}$/.test(o))) {
    return null;
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/** UTC calendar day, the rotation period for source hashes. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function sourceHash(
  testId: string,
  ip: string | null,
  now: number
): Promise<string | null> {
  if (!ip) {
    return null;
  }
  const prefix = ipPrefix(ip);
  if (!prefix) {
    return null;
  }
  return sha256Hex(`${testId}|${utcDay(now)}|${prefix}`);
}
