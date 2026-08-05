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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Two error shapes reach here: ours ({error}) and Better Auth's
    // ({message}). Surfacing either beats a bare status code.
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      body?.error ?? body?.message ?? `request failed (${res.status})`
    );
  }
  return (await res.json()) as T;
}

export async function fetchMe(): Promise<{
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
    void fetchMe().then(({ available, me }) => {
      setState({ ready: true, available, me });
    });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
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
