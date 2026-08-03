import { AUTO_SIGNALS, type AutoSignal } from "./signals.js";
import { testConfigSchema, type TestConfigInput } from "./schema.js";
import { computeTestId, type DecodedConfig } from "./codec.js";

/**
 * A test spelled out in plain query parameters, as an alternative to the
 * base64url config. Both parse into the same TestConfig and therefore the
 * same testId, so the two forms are two spellings of one test.
 *
 * This exists for email. An ESP template author wires the fixed parts
 * once (`k`, and whatever else the test needs), and campaign managers
 * fill in nothing but the variant URLs through their ordinary template
 * fields. They never encode anything, never visit this service, and never
 * learn it exists. Because variant URLs are inside the identity hash,
 * each campaign automatically becomes its own test while one stats secret
 * opens all of them.
 */

/** Parameters that configure the test itself. */
export const CONFIG_PARAMS = [
  "v", // variant target URL, repeated, in order (first = control)
  "vn", // variant name, repeated, positional
  "s", // starts a new slot: s=hero&v=..&v=..&s=cta&v=.. (multi-slot)
  "n", // test name
  "kh", // statsKeyHash: the HASH of the stats secret, never the secret
  "ctx", // comma-separated dims: "country:country,persona"
  "r", // fallback redirect target for clicks
  "stamp", // write the served combination into this param on redirect
  "fw" // fw=0 turns off forwarding unrecognized params
] as const;

/** Parameters the serving layer consumes; never config, never forwarded. */
export const RUNTIME_PARAMS = ["id", "auto", "to", "slot"] as const;

const RESERVED = new Set<string>([...CONFIG_PARAMS, ...RUNTIME_PARAMS]);

/** Context values arrive as c_<dim>; also ours, also never forwarded. */
function isContextParam(key: string): boolean {
  return key.startsWith("c_") && key.length > 2;
}

export function isReservedParam(key: string): boolean {
  return RESERVED.has(key) || isContextParam(key);
}

/**
 * Everything we did not recognize, to be carried onto the redirect
 * target. ESPs and ad platforms append their own attribution (utm_source,
 * gclid, mc_cid), and a redirect that swallowed them would break the
 * customer's analytics at exactly the moment it started being useful.
 */
export function passthroughParams(query: URLSearchParams): [string, string][] {
  return [...query.entries()].filter(([key]) => !isReservedParam(key));
}

function parseCtx(spec: string | null): TestConfigInput["ctx"] {
  if (!spec) {
    return undefined;
  }
  // "country:country,persona" -> country filled from the country signal,
  // persona supplied by the caller.
  const dims = spec
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [key, from] = entry.split(":").map(part => part.trim());
      return from && (AUTO_SIGNALS as readonly string[]).includes(from)
        ? { key, from: from as AutoSignal }
        : { key };
    })
    .filter(dim => dim.key.length > 0);
  return dims.length > 0 ? { dims } : undefined;
}

/**
 * Builds a config from query parameters. Only `a` (twice or more) is
 * required; everything else defaults, because the person filling in an
 * ESP template should not have to know this system has an algorithm, let
 * alone pick one.
 *
 * Throws exactly like decodeConfig does on anything unusable, so callers
 * can treat the two encodings identically.
 */
export async function configFromParams(
  query: URLSearchParams
): Promise<DecodedConfig> {
  // Slots are declared in order: `s=hero` opens a slot, the `v=`/`vn=`
  // pairs that follow belong to it, the next `s=` opens the next slot. A
  // template with no `s=` at all is the single-slot common case.
  const slots: Record<string, Array<{ name?: string; url: string }>> = {};
  let current = "main";
  let variantOrdinal = 0;
  // Names are positional against the v order across the whole query, so
  // `v=..&v=..&vn=hero&vn=lifestyle` works no matter where the vn sit.
  const names = query.getAll("vn");
  for (const [key, value] of query.entries()) {
    if (key === "s") {
      const slotKey = value.trim();
      if (slotKey.length > 0) {
        current = slotKey;
      }
      continue;
    }
    if (key === "v" && value.trim().length > 0) {
      const list = (slots[current] ??= []);
      const name = names[variantOrdinal]?.trim();
      list.push({ ...(name ? { name } : {}), url: value });
      variantOrdinal++;
    }
  }
  if (Object.keys(slots).length === 0) {
    throw new Error("a query-parameter test needs at least two `v` variants");
  }

  const input: TestConfigInput = {
    v: 2,
    slots,
    ...(query.get("n") ? { name: query.get("n") as string } : {}),
    // `kh` is the sha256 of the stats secret, which is why it is safe in
    // a link that reaches a million inboxes. A pasted secret is not
    // 64 hex characters, so the schema rejects it rather than quietly
    // running a different test than the sender meant.
    ...(query.get("kh") ? { statsKeyHash: query.get("kh") as string } : {}),
    ...(parseCtx(query.get("ctx")) ? { ctx: parseCtx(query.get("ctx")) } : {}),
    ...(query.get("r") ? { redirectUrl: query.get("r") as string } : {}),
    ...(query.get("stamp")
      ? { variantParam: query.get("stamp") as string }
      : {}),
    ...(query.get("fw") === "0" ? { forwardParams: false } : {})
  };
  const config = testConfigSchema.parse(input);
  return { config, testId: await computeTestId(config) };
}

/**
 * First usable variant URL, for the failure path. A malformed link in an
 * `img src` is a broken image in front of the entire recipient list, so a
 * config we cannot parse degrades to serving the control rather than to
 * an error. No test, but no visible damage either.
 */
export function fallbackTarget(query: URLSearchParams): string | null {
  for (const value of query.getAll("v")) {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return value;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Applies passthrough params and the variant stamp to a redirect target.
 * Existing params on the target win: the config author wrote those
 * deliberately, and silently overwriting them would be worse than
 * dropping an attribution tag.
 */
export function decorateDestination(
  target: string,
  options: {
    passthrough?: [string, string][];
    variantParam?: string;
    variantValue?: string;
  }
): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return target;
  }
  for (const [key, value] of options.passthrough ?? []) {
    if (!url.searchParams.has(key)) {
      url.searchParams.append(key, value);
    }
  }
  if (options.variantParam && options.variantValue !== undefined) {
    if (!url.searchParams.has(options.variantParam)) {
      url.searchParams.append(options.variantParam, options.variantValue);
    }
  }
  return url.toString();
}
