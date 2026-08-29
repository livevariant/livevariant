/**
 * The dashboard's client for the accounts surface: thin fetch wrappers
 * over /auth (Better Auth) and /account (the registry REST), plus a
 * React hook for session state. Everything is same-origin and
 * cookie-authenticated; no tokens ever live in this code.
 *
 * A deployment without accounts (any self-host without the module)
 * answers 404 on /account/me; the hook reports `available: false` and
 * every account surface in the UI simply does not render, which is the
 * account-free product unchanged.
 */
import { useCallback, useEffect, useState } from "react";

export interface AccountMe {
  userId: string;
  activeOrgId: string | null;
  orgs: Array<{ id: string; name: string; role?: string }>;
}

export interface AccountState {
  /** false until /account/me has answered once. */
  ready: boolean;
  /** Whether this deployment has accounts at all. */
  available: boolean;
  me: AccountMe | null;
  refresh: () => void;
}

export interface ServerTest {
  testId: string;
  kh: string | null;
  name: string | null;
  encoded: string;
  region: string | null;
  addedAt: number;
}

/** A failed /auth or /account response, keeping Better Auth's machine code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Two error shapes reach here: ours ({error}) and Better Auth's
    // ({message}, plus a stable code). Surfacing either beats a bare
    // status code; the code lets callers react to a specific failure
    // (EMAIL_NOT_VERIFIED) without matching prose.
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
      code?: string;
    } | null;
    throw new ApiError(
      body?.error ?? body?.message ?? `request failed (${res.status})`,
      body?.code
    );
  }
  return (await res.json()) as T;
}

/**
 * One /account/me per page load, shared by every useAccount consumer
 * (the header, the builder, ...) and by StrictMode's double effects.
 * refresh() invalidates it, which is how sign-in/out propagates.
 */
let mePromise: Promise<{
  available: boolean;
  me: AccountMe | null;
}> | null = null;

/** Test hook: specs stub fetch per test; the cache must not span them. */
export function resetAccount(): void {
  mePromise = null;
}

export function fetchMe(): Promise<{
  available: boolean;
  me: AccountMe | null;
}> {
  mePromise ??= fetchMeUncached();
  return mePromise;
}

async function fetchMeUncached(): Promise<{
  available: boolean;
  me: AccountMe | null;
}> {
  try {
    const res = await fetch("/account/me", { credentials: "include" });
    if (res.status === 404) {
      return { available: false, me: null };
    }
    if (res.status === 401) {
      return { available: true, me: null };
    }
    return { available: true, me: await json<AccountMe>(res) };
  } catch {
    return { available: false, me: null };
  }
}

export function useAccount(): AccountState {
  const [state, setState] = useState<Omit<AccountState, "refresh">>({
    ready: false,
    available: false,
    me: null
  });
  const refresh = useCallback(() => {
    // A refresh means something changed (sign-in, sign-out, org
    // switch): drop the shared cache so every consumer re-reads.
    mePromise = null;
    void fetchMe().then(({ available, me }) => {
      setState({ ready: true, available, me });
    });
  }, []);
  // Mount reads through the cache; only explicit refreshes invalidate.
  const mount = useCallback(() => {
    void fetchMe().then(({ available, me }) => {
      setState({ ready: true, available, me });
    });
  }, []);
  useEffect(() => {
    mount();
  }, [mount]);
  return { ...state, refresh };
}

/** Sends the magic link; resolves when the email is on its way. */
export async function requestMagicLink(
  email: string,
  next: string
): Promise<void> {
  await json(
    await fetch("/auth/sign-in/magic-link", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        callbackURL: new URL(next, window.location.origin).toString()
      })
    })
  );
}

/** Creates the account and signs this browser in. */
export async function registerWithPassword(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<void> {
  await json(
    await fetch("/auth/sign-up/email", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        // Better Auth requires a name; the email prefix is an honest
        // default nobody has to think about.
        name: input.name?.trim() || input.email.split("@")[0]
      })
    })
  );
}

export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<void> {
  await json(
    await fetch("/auth/sign-in/email", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: input.email, password: input.password })
    })
  );
}

/**
 * Re-sends the verification email for an unverified account, which is
 * the recovery path for an expired link. Better Auth answers success
 * regardless of whether the address exists, so exposing this on the
 * sign-in error path leaks nothing.
 */
export async function resendVerificationEmail(email: string): Promise<void> {
  await json(
    await fetch("/auth/send-verification-email", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email })
    })
  );
}

export async function signOut(): Promise<void> {
  await fetch("/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
}

/**
 * Claims the key behind a stats secret and registers the test under it,
 * which is the whole "add to my account" gesture: the secret is sent
 * once over the same-origin connection, hashed server-side, never
 * stored.
 */
export async function claimAndRegister(input: {
  statsSecret: string;
  encoded: string;
  name?: string;
  label?: string;
}): Promise<void> {
  await json(
    await fetch("/account/keys", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        statsSecret: input.statsSecret,
        label: input.label
      })
    })
  );
  await json(
    await fetch("/account/tests", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ encoded: input.encoded, name: input.name })
    })
  );
}

export interface TestStatus {
  testId: string;
  claimed: boolean;
  org: { name: string; mine: boolean } | null;
  destinations: Array<{ host: string; verified: boolean }>;
}

/**
 * What the registry knows about one test, proven by its stats secret:
 * claimed (by whose org) and destination verification. The manage page
 * asks on load so a reload shows "already in your account" instead of
 * re-offering the claim button.
 */
export async function fetchTestStatus(input: {
  encoded: string;
  statsSecret: string;
}): Promise<TestStatus> {
  return json(
    await fetch("/account/tests/status", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    })
  ) as Promise<TestStatus>;
}

export async function listServerTests(options: {
  q?: string;
  cursor?: string;
}): Promise<{ tests: ServerTest[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.q) {
    params.set("q", options.q);
  }
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  const query = params.toString();
  return json(
    await fetch(`/account/tests${query ? `?${query}` : ""}`, {
      credentials: "include"
    })
  );
}

// ---- organizations -------------------------------------------------------
// These call Better Auth's organization plugin directly (same-origin,
// cookie-authenticated); /account/me stays the summary the shell reads.

export interface OrgMember {
  id: string;
  role: string;
  user: { email: string; name: string | null };
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
}

export interface FullOrganization {
  id: string;
  name: string;
  members: OrgMember[];
  invitations: OrgInvitation[];
}

export async function setActiveOrg(organizationId: string): Promise<void> {
  await json(
    await fetch("/auth/organization/set-active", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId })
    })
  );
}

export async function createOrg(name: string): Promise<{ id: string }> {
  const slugBase = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // A random suffix keeps slugs (globally unique) from colliding on
  // common names; nobody types these anywhere.
  const slug = `${slugBase || "org"}-${Math.random().toString(36).slice(2, 8)}`;
  return json(
    await fetch("/auth/organization/create", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug })
    })
  );
}

export async function fullOrganization(
  organizationId: string
): Promise<FullOrganization> {
  return json(
    await fetch(
      `/auth/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`,
      { credentials: "include" }
    )
  );
}

export async function inviteMember(input: {
  email: string;
  role: "member" | "admin";
}): Promise<void> {
  await json(
    await fetch("/auth/organization/invite-member", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    })
  );
}

export async function cancelInvitation(invitationId: string): Promise<void> {
  await json(
    await fetch("/auth/organization/cancel-invitation", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId })
    })
  );
}

export interface InvitationDetails {
  id: string;
  email: string;
  role: string | null;
  organizationId: string;
  organizationName: string;
  status: string;
}

export async function getInvitation(id: string): Promise<InvitationDetails> {
  return json(
    await fetch(
      `/auth/organization/get-invitation?id=${encodeURIComponent(id)}`,
      { credentials: "include" }
    )
  );
}

export async function acceptInvitation(invitationId: string): Promise<void> {
  await json(
    await fetch("/auth/organization/accept-invitation", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId })
    })
  );
}

export async function leaveOrg(organizationId: string): Promise<void> {
  await json(
    await fetch("/auth/organization/leave", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId })
    })
  );
}
