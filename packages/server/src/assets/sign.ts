/**
 * Signed asset URLs. An asset's canonical address (/a/<sha256>) is
 * deliberately unusable on its own: serving appends a short-lived HMAC,
 * so the only working links are the ones our serve endpoint just minted.
 * That is the whole anti-hotlinking story; without it, uploads would be
 * free static hosting on our domains.
 *
 * The signature covers the asset id and the expiry, keyed by a secret the
 * operator holds. Web Crypto only, so it runs in Workers, Node and tests
 * alike.
 */

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Query string granting access to one asset until `expiresAt` (ms epoch). */
export async function signAsset(
  secret: string,
  assetId: string,
  expiresAt: number
): Promise<string> {
  const e = Math.floor(expiresAt / 1000);
  return `e=${e}&s=${await hmacHex(secret, `${assetId}:${e}`)}`;
}

export async function verifyAssetSignature(
  secret: string,
  assetId: string,
  e: string | undefined,
  s: string | undefined,
  now: number
): Promise<boolean> {
  if (!e || !s || !/^\d{1,12}$/.test(e)) {
    return false;
  }
  if (Number(e) * 1000 < now) {
    return false;
  }
  const expected = await hmacHex(secret, `${assetId}:${e}`);
  // Constant-time compare; both sides are fixed-length lowercase hex.
  if (s.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ s.charCodeAt(i);
  }
  return diff === 0;
}
