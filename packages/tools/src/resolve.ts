import {
  configFromParams,
  decodeConfig,
  type DecodedConfig
} from "@livevariant/core";
import { ToolInputError } from "./types.js";

/**
 * Turns whatever a person pasted into a decoded test. An assistant is
 * handed a link out of an email template, a dashboard address bar, or a
 * bare config string, and being strict about which is a good way to make
 * a working product feel broken.
 *
 * Accepted: an encoded config on its own, any serving/manage URL carrying
 * one in its path, and the query-parameter spelling.
 */
export interface ResolvedTest extends DecodedConfig {
  /** Present when a manage URL carried the secret in its #fragment. */
  statsSecret?: string;
  /** The origin the URL pointed at, when it came from a URL. */
  serverUrl?: string;
}

/** Path segments that are followed by an encoded config. */
const CONFIG_ROUTES = new Set(["s", "c", "px", "manage", "stats", "recompute"]);

export async function resolveTest(reference: string): Promise<ResolvedTest> {
  const ref = reference.trim();
  if (ref === "") {
    throw new ToolInputError("no test given");
  }

  if (!/^https?:\/\//i.test(ref)) {
    // Not a URL, so it can only be the config itself.
    try {
      return await decodeConfig(ref);
    } catch (err) {
      throw new ToolInputError(
        `not a LiveVariant test: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new ToolInputError(`not a URL: ${ref}`);
  }
  // The manage link keeps the secret in its fragment so it never reaches a
  // server log; taking it from there saves the caller pasting it twice.
  const statsSecret = url.hash.replace(/^#/, "") || undefined;
  const serverUrl = url.origin;

  const [route, encoded] = url.pathname.replace(/^\//, "").split("/");
  if (CONFIG_ROUTES.has(route) && encoded) {
    try {
      return { ...(await decodeConfig(encoded)), statsSecret, serverUrl };
    } catch (err) {
      throw new ToolInputError(
        `that URL's config will not decode: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // No config in the path: the query-parameter spelling, or nothing.
  try {
    return {
      ...(await configFromParams(url.searchParams)),
      statsSecret,
      serverUrl
    };
  } catch (err) {
    throw new ToolInputError(
      `that URL carries no LiveVariant test: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Resolves a variant by name or index, which is how an assistant refers to
 * one after reading stats. Names win; a bare number is an index.
 */
export function resolveVariantIndex(
  armNames: string[],
  reference: string | number
): number {
  if (typeof reference === "number") {
    if (
      !Number.isInteger(reference) ||
      reference < 0 ||
      reference >= armNames.length
    ) {
      throw new ToolInputError(
        `variant ${reference} is outside this test's ${armNames.length} variants`
      );
    }
    return reference;
  }
  const byName = armNames.indexOf(reference.trim());
  if (byName >= 0) {
    return byName;
  }
  const asNumber = Number(reference);
  if (Number.isInteger(asNumber)) {
    return resolveVariantIndex(armNames, asNumber);
  }
  throw new ToolInputError(
    `no variant called "${reference}"; this test has ${armNames.join(", ")}`
  );
}
