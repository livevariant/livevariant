/**
 * Domain verification: prove control of a hostname by publishing a
 * token, either as a DNS TXT record at _livevariant.<domain> (checked
 * over DoH, since Workers cannot do raw DNS) or as a well-known file.
 *
 * Both checks are outbound requests driven by attacker-chosen input,
 * so every knob here is a hardening decision: https only, no IP
 * literals, redirects never followed (following one would let a domain
 * that merely redirects somewhere attacker-controlled verify), small
 * body caps, short timeouts.
 */

export const TXT_PREFIX = "_livevariant";
export const TXT_VALUE_PREFIX = "livevariant-site-verification=";
export const WELL_KNOWN_PATH = "/.well-known/livevariant-verification.txt";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_024;

export interface VerifyResult {
  ok: boolean;
  method?: "dns-txt" | "well-known";
  reason?: string;
}

/**
 * Normalizes user input into a bare storable hostname, or explains why
 * not. Rejects IP literals and bare public-suffix-looking names: with a
 * globally unique domains table, letting someone "verify" `com` would
 * poison every future user.
 */
export function normalizeDomain(
  input: string
): { domain: string } | { error: string } {
  let host = input.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return { error: "not a valid domain" };
    }
  }
  host = host
    .replace(/^www\./, "")
    .replace(/\.$/, "")
    .split("/")[0];
  if (!host || !host.includes(".")) {
    return { error: "enter a full domain like example.com" };
  }
  if (/^[0-9.]+$/.test(host) || host.includes(":")) {
    return { error: "IP addresses cannot be verified" };
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host)) {
    return { error: "not a valid domain" };
  }
  return { domain: host };
}

export function generateVerificationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    out += "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36];
  }
  return out;
}

/** The instructions handed back when a domain is added. */
export function verificationInstructions(domain: string, token: string) {
  return {
    dnsTxt: {
      name: `${TXT_PREFIX}.${domain}`,
      type: "TXT",
      value: `${TXT_VALUE_PREFIX}${token}`
    },
    wellKnown: {
      url: `https://${domain}${WELL_KNOWN_PATH}`,
      body: token
    }
  };
}

export async function verifyDomain(
  domain: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<VerifyResult> {
  const viaDns = await checkDnsTxt(domain, token, fetchImpl);
  if (viaDns) {
    return { ok: true, method: "dns-txt" };
  }
  const viaFile = await checkWellKnown(domain, token, fetchImpl);
  if (viaFile) {
    return { ok: true, method: "well-known" };
  }
  return {
    ok: false,
    reason:
      `no ${TXT_PREFIX} TXT record and no ${WELL_KNOWN_PATH} file ` +
      `matched the verification token`
  };
}

async function checkDnsTxt(
  domain: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<boolean> {
  try {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(
      `${TXT_PREFIX}.${domain}`
    )}&type=TXT`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as {
      Answer?: Array<{ type: number; data: string }>;
    };
    const wanted = `${TXT_VALUE_PREFIX}${token}`;
    return (body.Answer ?? []).some(
      answer =>
        answer.type === 16 && answer.data.replaceAll('"', "").trim() === wanted
    );
  } catch {
    return false;
  }
}

async function checkWellKnown(
  domain: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://${domain}${WELL_KNOWN_PATH}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status !== 200) {
      return false;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      return false;
    }
    let received = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += new TextDecoder().decode(value);
      if (received.length > MAX_BODY_BYTES) {
        await reader.cancel();
        return false;
      }
    }
    return received.trim() === token;
  } catch {
    return false;
  }
}
