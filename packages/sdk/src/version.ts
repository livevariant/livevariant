import packageJson from "@livevariant/sdk/package.json" with { type: "json" };

/**
 * The npm package's own version, imported straight from package.json
 * (via the package's exported self-reference, so tsc treats it as an
 * external module and every bundler inlines it). Sent on every wire
 * request so the server knows which SDK generation it is talking to.
 */
export const SDK_VERSION: string = packageJson.version;
