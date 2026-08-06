/**
 * The Better Auth instance for the hosted deployment: magic link plus
 * Google sign-in, organizations from day one, Drizzle over D1 as the
 * single data layer (the same Drizzle instance backs the registry in
 * registry.ts, so auth and ownership share one database and one
 * migration pipeline).
 *
 * Better Auth is our IMPLEMENTATION of accounts, never their
 * definition: everything the serving path needs from accounts flows
 * through the dependency-free AccountsProvider port in
 * @livevariant/server, which a self-hoster can satisfy without this
 * package existing.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";
import {
  invitationEmail,
  magicLinkEmail,
  verificationEmail,
  type SendEmail
} from "./email.js";
import type { RenderPage } from "./domains.js";

export interface AccountsConfig {
  db: D1Database;
  /**
   * Absolute origin of the dashboard (https://livevariant.com). Cookies
   * and magic-link URLs key off it, which is why it comes from config
   * and never from the request.
   */
  baseUrl: string;
  /** Signing secret for sessions and tokens (LV_AUTH_SECRET). */
  secret: string;
  /**
   * Hostnames whose /a/<hash> URLs are THIS deployment's uploaded
   * assets (the dashboard host plus the serving host when separate).
   * Asset attribution only records these: a foreign host merely using
   * the same path shape must not create a reference to an internal
   * asset. Defaults to the baseUrl host.
   */
  assetHosts?: string[];
  /** Delivers magic links and verification emails (Resend in prod). */
  sendEmail: SendEmail;
  /**
   * JS-rendered page fetch for domain verification (Cloudflare Browser
   * Rendering on the hosted deployment). Optional: without it, only
   * snippets visible in raw HTML count, and tag-manager installs fall
   * back to DNS or the well-known file.
   */
  renderPage?: RenderPage;
}

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;

export function createAuth(config: AccountsConfig, db: Db) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    baseURL: config.baseUrl,
    // NOT the default /api/auth: /api/* belongs to the tool API and
    // carries wildcard CORS, which is incompatible with credentials.
    basePath: "/auth",
    secret: config.secret,
    trustedOrigins: [config.baseUrl],
    // Password AND magic link: the password pair is the register/sign-in
    // people expect, the link stays as the no-password alternative.
    // Registration is not done until the address is verified: sign-up
    // sends the verification email and sign-in refuses until the link
    // is clicked. A magic-link sign-in verifies inherently.
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await config.sendEmail(verificationEmail(user.email, url));
      }
    },
    session: {
      cookieCache: {
        // Signed cookie carries the session for this long between
        // database reads: sessionOrgIds on /stats stays cheap.
        enabled: true,
        maxAge: 60 * 5
      }
    },
    advanced: {
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
        httpOnly: true
      }
    },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await config.sendEmail(magicLinkEmail(email, url));
        }
      }),
      organization({
        sendInvitationEmail: async data => {
          // Better Auth generates no URL; the accept page is ours.
          await config.sendEmail(
            invitationEmail({
              to: data.email,
              orgName: data.organization.name,
              inviterName: data.inviter.user.name || data.inviter.user.email,
              url: `${config.baseUrl}/accept-invitation/${data.id}`
            })
          );
        }
      })
    ]
  });
}

export type Auth = ReturnType<typeof createAuth>;
