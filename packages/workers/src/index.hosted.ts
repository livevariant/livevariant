/**
 * The HOSTED Worker entry: everything the base entry does, plus the
 * accounts module. wrangler.jsonc points env.production.main here; a
 * bare `wrangler deploy` keeps using index.ts and never bundles an auth
 * framework, which is the self-host promise in build form.
 *
 * Accounts switch on only when every required binding is present
 * (mirroring how assets need both ASSET_STORE and LV_ASSET_SECRET), so
 * this entry also deploys cleanly on an account with no D1 database:
 * it just behaves exactly like the base entry.
 */
import { createApp } from "@livevariant/server";
import { createAccounts, resendMagicLink } from "@livevariant/accounts";
import { baseAppOptions, type Env } from "./index.js";

// wrangler resolves Durable Object class names against the entry
// module's exports: without this re-export the production deploy has no
// TestStateDO and fails.
export { TestStateDO } from "./index.js";

export interface HostedEnv extends Env {
  /** The accounts database; its absence turns the whole module off. */
  LV_ACCOUNTS_DB?: D1Database;
  /** Session/token signing secret (wrangler secret put LV_AUTH_SECRET). */
  LV_AUTH_SECRET?: string;
  /** Dashboard origin, e.g. https://livevariant.com. */
  LV_APP_URL?: string;
  /** Resend API key for magic-link email. */
  LV_RESEND_API_KEY?: string;
  /** From address; defaults to the LiveVariant login sender. */
  LV_EMAIL_FROM?: string;
  /**
   * Cloudflare Browser Rendering, for the tag-manager verification
   * path: rendering a homepage with JavaScript executed makes a
   * GTM-injected SDK snippet visible. Both present switches it on; the
   * token needs the "Browser Rendering - Edit" permission.
   */
  LV_CF_ACCOUNT_ID?: string;
  LV_CF_BROWSER_TOKEN?: string;
}

/**
 * The /content endpoint returns a page's HTML after JavaScript ran,
 * which is exactly the difference between "the SDK is in the source"
 * and "a tag manager injected the SDK". Failures return null: the
 * rendered pass is an extra chance, never a gate.
 */
function renderWithBrowserRendering(
  accountId: string,
  token: string
): (url: string) => Promise<string | null> {
  return async url => {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            url,
            // The SDK loads with the page's other scripts; idle-ish is
            // enough and keeps slow third parties from eating the run.
            gotoOptions: { waitUntil: "networkidle2", timeout: 15000 },
            rejectResourceTypes: ["image", "media", "font"]
          }),
          signal: AbortSignal.timeout(30_000)
        }
      );
      if (!res.ok) {
        return null;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = (await res.json()) as { result?: unknown };
        return typeof body.result === "string" ? body.result : null;
      }
      return await res.text();
    } catch {
      return null;
    }
  };
}

const apps = new WeakMap<HostedEnv, ReturnType<typeof createApp>>();

export default {
  fetch(request: Request, env: HostedEnv): Response | Promise<Response> {
    let app = apps.get(env);
    if (!app) {
      const options = baseAppOptions(env);
      if (env.LV_ACCOUNTS_DB && env.LV_AUTH_SECRET && env.LV_APP_URL) {
        const accounts = createAccounts({
          db: env.LV_ACCOUNTS_DB,
          baseUrl: env.LV_APP_URL,
          secret: env.LV_AUTH_SECRET,
          renderPage:
            env.LV_CF_ACCOUNT_ID && env.LV_CF_BROWSER_TOKEN
              ? renderWithBrowserRendering(
                  env.LV_CF_ACCOUNT_ID,
                  env.LV_CF_BROWSER_TOKEN
                )
              : undefined,
          // Without a Resend key the link goes to the worker log, which
          // is the local dev loop (wrangler dev prints it); production
          // sets the key so links actually arrive.
          sendMagicLink: env.LV_RESEND_API_KEY
            ? resendMagicLink({
                apiKey: env.LV_RESEND_API_KEY,
                from:
                  env.LV_EMAIL_FROM ??
                  "LiveVariant <login@mail.livevariant.com>"
              })
            : async (to, url) => {
                console.log(
                  `\n========================================\n` +
                    `[livevariant] magic sign-in link for ${to}\n${url}\n` +
                    `========================================\n`
                );
              }
        });
        options.accounts = accounts.routes;
        options.provider = accounts.provider;
        // The registry IS the hosted trust policy: verified domains
        // redirect silently, everything else external gets the continue
        // screen. Overrides the env-derived policy from baseAppOptions.
        options.trust = accounts.provider;
      }
      app = createApp(options);
      apps.set(env, app);
    }
    return app.fetch(request);
  }
};
