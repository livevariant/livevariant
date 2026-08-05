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
/** Homepage scan cap for SDK detection. */
const MAX_PAGE_BYTES = 512_000;

export interface VerifyResult {
  ok: boolean;
  method?: "dns-txt" | "well-known" | "sdk";
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
  // Two-label effective TLDs (co.uk, com.au, gov.br, ...) must not enter
  // a globally unique table: verifying one would trust-cover every site
  // under it. A full public-suffix list is overkill for a name a person
  // typed; the common second-level registries share this small shape.
  const labels = host.split(".");
  const SECOND_LEVEL = new Set([
    "co",
    "com",
    "net",
    "org",
    "gov",
    "edu",
    "ac",
    "or",
    "ne",
    "go",
    "mil"
  ]);
  // Only under two-letter country TLDs: go.com and co.com are real
  // registrable names, while co.uk / com.au / go.kr are registries.
  if (
    labels.length === 2 &&
    SECOND_LEVEL.has(labels[0]) &&
    labels[1].length === 2
  ) {
    return { error: "enter your full domain, not a public suffix" };
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

/**
 * Renders a page with JavaScript executed and returns its HTML, or null
 * when rendering is unavailable or fails. The hosted deployment backs
 * this with Cloudflare Browser Rendering, which is what makes an SDK
 * snippet injected through a tag manager (invisible to a raw fetch)
 * count for verification.
 */
export type RenderPage = (url: string) => Promise<string | null>;

export async function verifyDomain(
  domain: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  publishableKeys: string[] = [],
  renderPage?: RenderPage
): Promise<VerifyResult> {
  const viaDns = await checkDnsTxt(domain, token, fetchImpl);
  if (viaDns) {
    return { ok: true, method: "dns-txt" };
  }
  const viaFile = await checkWellKnown(domain, token, fetchImpl);
  if (viaFile) {
    return { ok: true, method: "well-known" };
  }
  const viaSdk = await checkSdkInstalled(domain, publishableKeys, fetchImpl);
  if (viaSdk) {
    return { ok: true, method: "sdk" };
  }
  // The rendered pass runs last: it is the expensive one, and the raw
  // fetch already caught every directly-embedded snippet.
  if (renderPage && publishableKeys.length > 0) {
    const html = await renderPage(`https://${domain}/`);
    if (html && publishableKeys.some(key => html.includes(key))) {
      return { ok: true, method: "sdk" };
    }
  }
  return {
    ok: false,
    reason:
      `no ${TXT_PREFIX} TXT record, no ${WELL_KNOWN_PATH} file, and no ` +
      `publishable key found on the homepage. Publish one of the ` +
      `verification records, or install the SDK with your publishable ` +
      `key and check again`
  };
}

/**
 * The zero-setup path: your publishable key sitting in the homepage's
 * HTML source proves exactly what the well-known file proves (you can
 * put content on this domain), so installing the SDK IS the
 * verification. This is a server-side fetch of the page, deliberately
 * NOT "we saw SDK traffic claiming this Origin": the Origin header and
 * the key are both public and forgeable by any non-browser client, so
 * observed traffic could squat a stranger's domain. A script injected
 * through a tag manager does not appear in the raw HTML; those setups
 * use DNS or the well-known file instead.
 */
async function checkSdkInstalled(
  domain: string,
  publishableKeys: string[],
  fetchImpl: typeof fetch
): Promise<boolean> {
  if (publishableKeys.length === 0) {
    return false;
  }
  try {
    let url = `https://${domain}/`;
    // Follow at most one redirect, and only within the same site
    // (apex to www is routine); anywhere else would let a domain that
    // merely redirects somewhere attacker-controlled verify.
    for (let hop = 0; hop < 2; hop++) {
      const res = await fetchImpl(url, {
        redirect: "manual",
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.status >= 300 && res.status < 400 && hop === 0) {
        const location = res.headers.get("location");
        if (!location) {
          return false;
        }
        const target = new URL(location, url);
        const sameSite =
          target.protocol === "https:" &&
          (target.hostname === domain ||
            target.hostname === `www.${domain}` ||
            domain === target.hostname.replace(/^www\./, ""));
        if (!sameSite) {
          return false;
        }
        url = target.toString();
        continue;
      }
      if (res.status !== 200 || !res.body) {
        return false;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received += decoder.decode(value, { stream: true });
        if (publishableKeys.some(key => received.includes(key))) {
          await reader.cancel();
          return true;
        }
        // Homepages are big but keys sit in the first script tags; a
        // cap keeps a hostile endless stream from pinning the worker.
        if (received.length > MAX_PAGE_BYTES) {
          await reader.cancel();
          return false;
        }
      }
      return publishableKeys.some(key => received.includes(key));
    }
    return false;
  } catch {
    return false;
  }
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
