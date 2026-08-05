/**
 * @livevariant/accounts: the hosted deployment's accounts module.
 * Private, never published, and never imported by the self-host Worker
 * entry; @livevariant/server talks to it only through the
 * AccountsProvider and TrustPolicy ports.
 *
 * `createAccounts` is the one call the hosted entry makes: it wires
 * Drizzle over D1, Better Auth (built lazily so the serving path's cold
 * start never evaluates the plugin graph), the registry routes, and the
 * cached provider that implements both ports.
 */
import {
  createAuth,
  createDb,
  type AccountsConfig,
  type Auth
} from "./auth.js";
import { RegistryProvider } from "./provider.js";
import { createAccountRoutes } from "./routes.js";
import type { Hono } from "hono";

export interface Accounts {
  /** Mount at "/" via AppOptions.accounts. */
  routes: Hono;
  /** Pass as AppOptions.provider and AppOptions.trust. */
  provider: RegistryProvider;
}

export function createAccounts(config: AccountsConfig): Accounts {
  const db = createDb(config.db);
  let auth: Auth | undefined;
  const lazyAuth = () => (auth ??= createAuth(config, db));
  // The provider needs auth only for session lookups, which cannot
  // happen before a sign-in has happened through the routes; the lazy
  // thunk keeps construction off the serving path either way.
  const provider = new RegistryProvider(db, lazyAuth);
  const routes = createAccountRoutes({
    db,
    auth: lazyAuth,
    provider,
    baseUrl: config.baseUrl,
    renderPage: config.renderPage
  });
  return { routes, provider };
}

export { resendMailer, type OutgoingEmail, type SendEmail } from "./email.js";
export type { AccountsConfig } from "./auth.js";
export { RegistryProvider } from "./provider.js";
