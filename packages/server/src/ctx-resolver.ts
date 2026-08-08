import type { CtxDim, RequestSignals } from "@livevariant/core";

/**
 * The context-resolution port: how a deployment turns something it was
 * given into a bucket it can learn from.
 *
 * Some dimensions are not signals to read but questions to ask. A
 * postcode has to become a segment, an account id a plan tier, and the
 * thing that knows is a service. A config declares such a dimension with
 * `resolve: "<name>"` and the deployment supplies a resolver under that
 * name; nothing about the lookup is encoded in the config, so the same
 * test config means the same thing wherever it is served.
 *
 * WHERE THIS RUNS, and why it matters:
 *
 * Between normalizing the caller's context and hashing anything. The raw
 * input is read, sent wherever it needs to go, and dropped; only the
 * answer reaches `ctxKey` and `featIdx`. That is what keeps the
 * privacy-by-minimization claim true for a dimension whose input is a
 * postcode.
 *
 * It also runs on the REDIRECT paths only. /choose carries a context hash
 * computed on the page precisely so raw values never leave it, so a
 * resolved dimension cannot be filled there; a page that wants one
 * resolves it itself and passes the answer as ordinary context.
 */

export interface CtxResolveInput {
  testId: string;
  /**
   * The dimensions naming this resolver, with their `values` allowlist.
   * More than one dimension may share a resolver, so the answer is a map
   * rather than a single value.
   */
  dims: readonly CtxDim[];
  /**
   * The caller's context BEFORE normalization, which is the point: the
   * resolver's INPUT need not be a declared dimension, so a postcode can
   * arrive as `?c_postcode=` without ever becoming a bucket of its own.
   */
  raw: Readonly<Record<string, string>>;
  /** Signals derived from the request (country, device, utm tags). */
  signals: RequestSignals;
  /** The request being served, for anything else the host needs. */
  request?: Request;
  /** Already armed with the deployment's resolve timeout. */
  signal: AbortSignal;
}

export interface CtxResolver {
  /**
   * Values for the dimensions named in `input.dims`, keyed by dimension.
   * An absent or undefined key leaves that dimension out of the bucket.
   *
   * MUST be cheap and idempotent. It runs on every serve, not once per
   * visitor: identity is computed before the store decides who is new, so
   * there is no "first time" for a host to key a cache off. Cache it.
   *
   * MAY fail. A rejection, a timeout or a value outside the dimension's
   * allowlist leaves the dimension absent and the serve continues, because
   * a serve is often an email image fetch and must never hang or 500 on a
   * third party being down. The cost of failing is real but bounded, and
   * it is worth stating: assignment is sticky, so a visitor whose FIRST
   * request failed to resolve stays unbucketed for the life of the test.
   */
  resolve(input: CtxResolveInput): Promise<Record<string, string | undefined>>;
}

/** Resolvers by the name a config's `resolve` field can point at. */
export type CtxResolvers = Record<string, CtxResolver>;

/** What `resolveIdentity` calls; the app builds it from the registry. */
export type ResolveCtxFn = (input: {
  dims: readonly CtxDim[];
  raw: Readonly<Record<string, string>>;
  signals: RequestSignals;
}) => Promise<Record<string, string | undefined>>;

/** Default budget for the whole resolution step, in milliseconds. */
export const DEFAULT_CTX_RESOLVE_TIMEOUT_MS = 150;

/**
 * Resolves to `null` instead of rejecting or hanging. Both failure modes
 * mean the same thing here (no answer), and neither may take a serve down
 * with it.
 */
function settleOrGiveUp<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const finish = (value: T | null): void => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(finish, () => finish(null));
  });
}

/**
 * Binds a registry of resolvers to one request: groups the config's
 * resolved dimensions by resolver name, asks each one, and merges the
 * answers. Returns undefined when there is nothing to resolve, so the
 * common path costs nothing.
 */
export function bindCtxResolvers(options: {
  testId: string;
  resolvers: CtxResolvers | undefined;
  timeoutMs?: number;
  request?: Request;
}): ResolveCtxFn | undefined {
  const resolvers = options.resolvers;
  if (!resolvers || Object.keys(resolvers).length === 0) {
    return undefined;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CTX_RESOLVE_TIMEOUT_MS;
  return async ({ dims, raw, signals }) => {
    const byName = new Map<string, CtxDim[]>();
    for (const dim of dims) {
      if (dim.resolve && resolvers[dim.resolve]) {
        const list = byName.get(dim.resolve) ?? [];
        list.push(dim);
        byName.set(dim.resolve, list);
      }
    }
    if (byName.size === 0) {
      return {};
    }
    // One budget for the step, not one per resolver: a config naming
    // three of them must not be able to hold a serve for three timeouts.
    const signal = AbortSignal.timeout(timeoutMs);
    const answers = await Promise.all(
      [...byName].map(([name, resolverDims]) =>
        settleOrGiveUp(
          resolvers[name].resolve({
            testId: options.testId,
            dims: resolverDims,
            raw,
            signals,
            request: options.request,
            signal
          }),
          timeoutMs
        )
      )
    );
    return Object.assign({}, ...answers.map(a => a ?? {})) as Record<
      string,
      string | undefined
    >;
  };
}
