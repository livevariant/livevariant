/**
 * One resolver for the two ways a test reaches the stats page: saved in
 * this browser (/tests/:testId, localStorage) or carried entirely in
 * the URL (/manage/:encoded, secret in the #fragment, which never
 * leaves the browser). Both resolve to the same shape, so TestDetail is
 * one page with one feature set, and the old server-rendered manage
 * shell could be deleted.
 */
import { useEffect, useState } from "react";
import { decodeConfig } from "@livevariant/core";
import { loadTests, saveTest, type SavedTest } from "./tests-store";
import { fetchServeUrl } from "./serve-url";

export interface ResolvedTest {
  testId: string;
  encoded: string;
  name: string;
  /** null on a manage link opened without its #fragment. */
  statsSecret: string | null;
  /** The public hash from the config; null for keyless tests. */
  statsKeyHash: string | null;
  /** Origin for visitor-facing links (serve/click/pixel). */
  serveUrl: string;
  /** Whether this browser's list already has it. */
  saved: boolean;
}

export function useResolvedTest(params: {
  testId?: string;
  encoded?: string;
}): { test: ResolvedTest | null; ready: boolean; save: () => void } {
  const [state, setState] = useState<{
    test: ResolvedTest | null;
    ready: boolean;
  }>({ test: null, ready: false });

  useEffect(() => {
    let live = true;
    void (async () => {
      const resolved = await resolve(params.testId, params.encoded);
      if (live) {
        setState({ test: resolved, ready: true });
      }
    })();
    return () => {
      live = false;
    };
  }, [params.testId, params.encoded]);

  const save = () => {
    const t = state.test;
    if (!t || !t.statsSecret) {
      return;
    }
    const entry: SavedTest = {
      name: t.name,
      encoded: t.encoded,
      testId: t.testId,
      statsSecret: t.statsSecret,
      serverUrl: t.serveUrl,
      createdAt: Date.now()
    };
    saveTest(entry);
    setState({ test: { ...t, saved: true }, ready: true });
  };

  return { ...state, save };
}

async function resolve(
  testId?: string,
  encoded?: string
): Promise<ResolvedTest | null> {
  if (testId) {
    const saved = loadTests().find(t => t.testId === testId);
    if (!saved) {
      return null;
    }
    let kh: string | null;
    try {
      kh = (await decodeConfig(saved.encoded)).config.statsKeyHash ?? null;
    } catch {
      kh = null;
    }
    return {
      testId: saved.testId,
      encoded: saved.encoded,
      name: saved.name,
      statsSecret: saved.statsSecret,
      statsKeyHash: kh,
      serveUrl: saved.serverUrl,
      saved: true
    };
  }
  if (!encoded) {
    return null;
  }
  let decoded;
  try {
    decoded = await decodeConfig(encoded);
  } catch {
    return null;
  }
  // The fragment IS the secret; it never reached the server.
  const secret = window.location.hash.replace(/^#/, "") || null;
  const saved = loadTests().find(t => t.testId === decoded.testId);
  return {
    testId: decoded.testId,
    encoded,
    name: decoded.config.name ?? "LiveVariant test",
    statsSecret: secret ?? saved?.statsSecret ?? null,
    statsKeyHash: decoded.config.statsKeyHash ?? null,
    serveUrl: saved?.serverUrl ?? (await fetchServeUrl()),
    saved: saved !== undefined
  };
}
