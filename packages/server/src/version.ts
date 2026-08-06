import packageJson from "@livevariant/server/package.json" with { type: "json" };

/**
 * The server package's own version, imported straight from
 * package.json (via the exported self-reference). Sent on every
 * response so clients can make compatibility decisions later.
 */
export const SERVER_VERSION: string = packageJson.version;
