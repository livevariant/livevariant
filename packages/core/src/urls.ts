/**
 * URL construction for a test, shared by the SDK and the web app (and the
 * planned MCP builder) so every surface produces identical links. `base` is the serving
 * origin (hosted: https://livevariant.link; self-host: wherever the server
 * runs). The manage URL carries the stats secret in the FRAGMENT: it never
 * leaves the browser, so it stays out of server and proxy logs.
 */
export interface TestUrls {
  serve: string;
  click: string;
  pixel: string;
  manage: string;
}

export function buildTestUrls(
  base: string,
  encoded: string,
  statsSecret?: string
): TestUrls {
  const origin = base.replace(/\/+$/, "");
  return {
    serve: `${origin}/s/${encoded}`,
    click: `${origin}/c/${encoded}`,
    pixel: `${origin}/px/${encoded}`,
    manage: `${origin}/manage/${encoded}${statsSecret ? `#${statsSecret}` : ""}`
  };
}
