import { sha256Hex } from "./canonical.js";

/**
 * Source bucketing. Writes are unauthenticated by design (the config is
 * public), so each record carries a coarse, deliberately forgettable
 * fingerprint of where it came from: enough for a creator to see a flood
 * and quarantine it, not enough to identify anyone.
 *
 *   srcHash = sha256(testId | dateUTC | ipPrefix)
 *
 * The raw address is never stored, the hash is scoped to one test and
 * one day (so it is neither a cross-test nor a long-term identifier),
 * and only the creator can ever see it. The honest caveat, which the
 * README states: a creator could brute-force a /24 back out of the hash
 * for their own traffic.
 */

/** Bucket for requests whose address is missing or unparseable. */
export const UNKNOWN_SOURCE = "unknown";

/**
 * Expands an IPv6 address to its eight groups. `::` compresses a RUN of
 * zero groups, not a single one, so a naive split puts the wrong values
 * in the leading positions: 2001::1 reads as 2001:0:1 instead of
 * 2001:0:0. That matters because two addresses inside one /48 would then
 * land in different buckets, which is exactly the cap evasion this
 * bucketing exists to prevent.
 */
function expandIpv6(address: string): string[] | null {
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 1
      ? head
      : [
          ...head,
          ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill(
            "0"
          ),
          ...tail
        ];
  if (groups.length !== 8) {
    return null;
  }
  const normalized: string[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }
    // Canonical form, so 0db8 and db8 share one bucket.
    normalized.push(parseInt(group, 16).toString(16));
  }
  return normalized;
}

function ipv4Prefix(address: string): string | null {
  const octets = address.split(".");
  if (octets.length !== 4) {
    return null;
  }
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) {
      return null;
    }
  }
  return `${Number(octets[0])}.${Number(octets[1])}.${Number(octets[2])}.0/24`;
}

/** IPv4 collapses to its /24, IPv6 to its /48. */
export function ipPrefix(ip: string): string | null {
  // Strip a zone id (fe80::1%eth0) and any surrounding brackets.
  const trimmed = ip
    .trim()
    .toLowerCase()
    .split("%")[0]
    .replace(/^\[|\]$/g, "");
  if (trimmed === "") {
    return null;
  }
  if (!trimmed.includes(":")) {
    return ipv4Prefix(trimmed);
  }
  // IPv4-mapped forms (::ffff:203.0.113.42) bucket as the IPv4 address
  // they carry, since that is what identifies the source.
  const lastGroup = trimmed.slice(trimmed.lastIndexOf(":") + 1);
  if (lastGroup.includes(".")) {
    return ipv4Prefix(lastGroup);
  }
  const groups = expandIpv6(trimmed);
  return groups ? `${groups.slice(0, 3).join(":")}::/48` : null;
}

/** UTC calendar day, the rotation period for source hashes. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The bucket recorded on an assignment. Null when the address is missing
 * or unparseable, which simply means that record cannot be attributed to
 * a source and cannot be quarantined by one.
 */
export async function sourceHash(
  testId: string,
  ip: string | null,
  now: number
): Promise<string | null> {
  const prefix = ip ? ipPrefix(ip) : null;
  return prefix ? sha256Hex(`${testId}|${utcDay(now)}|${prefix}`) : null;
}

/**
 * The bucket used for rate limiting, which unlike capping must never
 * return null: a caller that omits its address headers would otherwise
 * skip the limiter entirely. Unidentified callers share one bucket and
 * therefore one allowance, which is the conservative direction.
 */
export async function rateLimitBucket(
  testId: string,
  ip: string | null,
  now: number
): Promise<string> {
  const prefix = (ip ? ipPrefix(ip) : null) ?? UNKNOWN_SOURCE;
  return sha256Hex(`${testId}|${utcDay(now)}|${prefix}`);
}
