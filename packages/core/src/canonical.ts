/**
 * Canonical serialization and hashing primitives.
 *
 * Everything here must be byte-identical across Node, Cloudflare Workers,
 * and browsers: the test's identity is a hash of this output, so any
 * platform divergence would split one test's state into two.
 */

/** Deterministic JSON: object keys sorted, undefined-valued keys dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalJson(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter(k => record[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlToBytes(encoded: string): Uint8Array {
  const b64 =
    encoded.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (encoded.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export function base64UrlToUtf8(encoded: string): string {
  return new TextDecoder().decode(base64UrlToBytes(encoded));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Non-cryptographic 32-bit FNV-1a. Used only for feature hashing in the
 * linear bandit, where we need a fast synchronous hash that is identical
 * on every platform; nothing secret depends on it.
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
