import { AUTO_SIGNALS, type AutoSignal } from "./signals.js";
import {
  parseTestConfig,
  type TestConfig,
  type TestConfigInput
} from "./schema.js";
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
  "sr", // per-slot redirect target, binds to the slot most recently opened
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
  const slotRedirects: Record<string, string> = {};
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
    // `sr` binds to the slot most recently opened, exactly like `v` does,
    // so an element's landing page sits next to its variants in the
    // template instead of in a positional list somewhere else.
    if (key === "sr" && value.trim().length > 0) {
      slotRedirects[current] = value;
    }
  }
  if (Object.keys(slots).length === 0) {
    throw new Error("a query-parameter test needs at least two `v` variants");
  }

  const ctx = parseCtx(query.get("ctx"));
  const input: TestConfigInput = {
    v: 2,
    slots,
    ...(query.get("n") ? { name: query.get("n") as string } : {}),
    // `kh` is the sha256 of the stats secret, which is why it is safe in
    // a link that reaches a million inboxes. A pasted secret is not
    // 64 hex characters, so the schema rejects it rather than quietly
    // running a different test than the sender meant.
    ...(query.get("kh") ? { statsKeyHash: query.get("kh") as string } : {}),
    ...(ctx ? { ctx } : {}),
    ...(query.get("r") ? { redirectUrl: query.get("r") as string } : {}),
    ...(Object.keys(slotRedirects).length > 0 ? { slotRedirects } : {}),
    ...(query.get("stamp")
      ? { variantParam: query.get("stamp") as string }
      : {}),
    ...(query.get("fw") === "0" ? { forwardParams: false } : {})
  };
  const config = parseTestConfig(input);
  return { config, testId: await computeTestId(config) };
}

/**
 * The inverse of configFromParams: spells a config out as readable query
 * parameters, or returns null when the config uses features the parameter
 * form cannot express. Powers the manage page's "show as plain URL"
 * toggle, so a creator can SEE how their test would be written by hand.
 *
 * Only identity-relevant fields matter for fidelity: identity-excluded
 * tuning (priors, decorateRedirects, ...) is defaulted by the parameter
 * form without changing the testId. Not expressible: non-URL variant
 * content, per-variant redirects, ctx value allowlists, reward events,
 * and partially-named variants (vn is positional, so it is all or none).
 */
export function configToParams(config: TestConfig): URLSearchParams | null {
  const entries = Object.entries(config.slots);
  const variants = entries.flatMap(([, list]) => list);
  const expressible =
    variants.every(
      v =>
        v.url !== undefined &&
        v.image === undefined &&
        v.html === undefined &&
        v.md === undefined &&
        v.text === undefined &&
        v.redirectUrl === undefined
    ) &&
    (config.ctx?.dims ?? []).every(dim => dim.values === undefined) &&
    config.rewardEvents === undefined;
  if (!expressible) {
    return null;
  }
  const named = variants.filter(v => v.name !== undefined).length;
  if (named !== 0 && named !== variants.length) {
    return null;
  }

  const query = new URLSearchParams();
  if (config.name) {
    query.set("n", config.name);
  }
  const singleMain = entries.length === 1 && entries[0][0] === "main";
  for (const [slotKey, list] of entries) {
    if (!singleMain) {
      query.append("s", slotKey);
    }
    // After the `s` that opens the slot and before its variants: `sr`
    // binds to the slot currently open, so position is the grammar.
    const slotRedirect = config.slotRedirects?.[slotKey];
    if (slotRedirect) {
      query.append("sr", slotRedirect);
    }
    for (const variant of list) {
      query.append("v", variant.url as string);
      if (variant.name !== undefined) {
        query.append("vn", variant.name);
      }
    }
  }
  if (config.ctx) {
    query.set(
      "ctx",
      config.ctx.dims
        .map(dim => (dim.from ? `${dim.key}:${dim.from}` : dim.key))
        .join(",")
    );
  }
  if (config.redirectUrl) {
    query.set("r", config.redirectUrl);
  }
  if (config.variantParam) {
    query.set("stamp", config.variantParam);
  }
  if (!config.forwardParams) {
    query.set("fw", "0");
  }
  if (config.statsKeyHash) {
    query.set("kh", config.statsKeyHash);
  }
  return query;
}

/**
 * The ESP-template spelling of a config: the same query string
 * configToParams produces, with every variant URL swapped for a merge
 * placeholder ({{hero_variant_1_url}}, or {{variant_1_url}} when the
 * test has one slot), every per-slot landing page swapped for
 * {{hero_landing_url}}, and, when no destination is set at all, an
 * r={{landing_url}} placeholder appended.
 *
 * Every URL in the template is a placeholder for the same reason: a
 * recurring campaign changes its creative AND where it points, and the
 * fields a campaign manager fills in are exactly the ones that should
 * mint a fresh test when they change.
 *
 * The critical property is that ONE string feeds every link in the
 * template. `r` is part of a test's identity, so a click link that
 * added r while the image links did not would reward a different test
 * than the one being served; deriving all links from this single
 * string makes that mistake impossible. Callers append only runtime
 * parameters (auto, id, slot), which never touch identity.
 *
 * Returns null for inline content, per-variant redirects and the other
 * query-inexpressible fields — with one deliberate exception to
 * configToParams' strictness: image variants. The parameter form's `v=`
 * always parses back as `url`, so an image-variant config has no
 * identity-preserving parameter spelling and configToParams rightly
 * refuses it. The template never needed that fidelity: every variant
 * URL becomes a merge placeholder below, and a filled-in template mints
 * its own test either way. Image variants are the canonical email case,
 * so they must not be the case that loses the template — including a
 * variant that carries BOTH image and url (both are content fields; the
 * flattened value is swapped for a placeholder regardless, so only the
 * slot structure has to survive). Per-variant redirectUrl stays
 * inexpressible: that field is grammar the parameter form truly lacks,
 * not a spelling difference.
 */
export function configToTemplateQuery(config: TestConfig): string | null {
  const spellable: TestConfig = {
    ...config,
    slots: Object.fromEntries(
      Object.entries(config.slots).map(([slotKey, list]) => [
        slotKey,
        list.map(v =>
          v.image !== undefined
            ? { ...v, url: v.url ?? v.image, image: undefined }
            : v
        )
      ])
    )
  };
  const params = configToParams(spellable);
  if (params === null) {
    return null;
  }
  const entries = Object.entries(config.slots);
  const singleMain = entries.length === 1 && entries[0][0] === "main";
  // Positional, exactly like the vn grammar: the nth v= in the string
  // is the nth variant in slot-declaration order.
  const placeholders = entries.flatMap(([slotKey, list]) =>
    list.map(
      (_, i) => `{{${singleMain ? "" : `${slotKey}_`}variant_${i + 1}_url}}`
    )
  );
  // Same grammar for the per-slot landing pages: the nth sr= belongs to
  // the nth slot that declares one, in the same declaration order.
  const landingPlaceholders = entries
    .filter(([slotKey]) => config.slotRedirects?.[slotKey])
    .map(([slotKey]) => `{{${singleMain ? "" : `${slotKey}_`}landing_url}}`);
  let variantOrdinal = 0;
  let landingOrdinal = 0;
  const pieces: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "v") {
      pieces.push(`v=${placeholders[variantOrdinal++]}`);
    } else if (key === "sr") {
      pieces.push(`sr=${landingPlaceholders[landingOrdinal++]}`);
    } else {
      pieces.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  // A test whose every slot names its own landing page needs no fallback;
  // anything else does, or its click links have nowhere to go.
  const everySlotCovered = entries.every(
    ([slotKey]) => config.slotRedirects?.[slotKey]
  );
  if (!params.has("r") && !everySlotCovered) {
    pieces.push("r={{landing_url}}");
  }
  return pieces.join("&");
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
