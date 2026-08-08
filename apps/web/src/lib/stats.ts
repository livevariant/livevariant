/**
 * The stats page's transport: a live subscription over the server's SSE
 * stream with an ordinary polling fallback, so the page shows moving
 * numbers on a current deployment and still shows numbers on an old one.
 *
 * The stream is consumed with a streaming fetch rather than EventSource
 * because EventSource cannot send headers, and the stats secret travels
 * ONLY as a Bearer header (query params would land in access logs). That
 * is also why this stayed here rather than moving to core with the
 * payload types and the derivation math: it is the one piece that assumes
 * the browser holds the secret, which an embedding dashboard keeping the
 * secret server-side would not do.
 */
import { normalizeStats, type TestStats } from "@livevariant/core";

export { normalizeStats };
export type { TestStats };

export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE parse: complete events out, the unfinished tail back.
 * Pure so the chunk-boundary cases are unit-testable without a server.
 */
export function parseSSE(buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  let sep;
  while ((sep = buffer.indexOf("\n\n")) !== -1) {
    const chunk = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
    events.push({ event, data: data.join("\n") });
  }
  return { events, rest: buffer };
}

export type StreamState = "connecting" | "live" | "polling" | "error";

/** Fallback cadence when the deployment has no stream endpoint. */
const POLL_INTERVAL_MS = 10_000;
/** Reconnect backoff cap; a stream that keeps dying is retried gently. */
const MAX_BACKOFF_MS = 15_000;

/** Resolves after `ms`, or immediately when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Subscribes to a test's live stats. Emits every payload through
 * `onStats` and the connection's health through `onState`; returns an
 * unsubscribe. Reconnects with backoff when the stream drops, and
 * degrades to plain polling when the server has no stream at all. A 401
 * is terminal: a wrong secret does not become right by retrying.
 */
export function subscribeStats(
  encoded: string,
  statsSecret: string | null,
  onStats: (stats: TestStats) => void,
  onState: (state: StreamState, detail?: string) => void
): () => void {
  let stopped = false;
  // One controller for the subscription's whole lifetime: it aborts the
  // in-flight fetch, wakes any pending sleep, AND cancels the stream
  // reader. Aborting only the fetch is not enough, because a reader
  // blocked on read() is not interrupted by its fetch's abort.
  const controller = new AbortController();
  const auth: Record<string, string> = statsSecret
    ? { authorization: `Bearer ${statsSecret}` }
    : {};

  // Same-origin on purpose: the one Worker answers /stats on every
  // hostname it serves, and a signed-in member of the owning org can
  // read without the bearer secret at all (hence the credentials).
  async function fetchOnce(): Promise<void> {
    const res = await fetch(`/stats/${encoded}`, {
      credentials: "include",
      headers: auth,
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`stats request failed (${res.status})`);
    }
    onStats(normalizeStats(await res.json()));
  }

  async function readStream(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    const cancel = () => void reader.cancel().catch(() => undefined);
    controller.signal.addEventListener("abort", cancel);
    try {
      await consume(reader);
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      cancel();
    }
  }

  async function consume(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSSE(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.event === "stats") {
          onStats(normalizeStats(JSON.parse(event.data)));
        }
        // Any event, ping included, proves the connection is alive.
        onState("live");
      }
    }
  }

  async function run(): Promise<void> {
    let failures = 0;
    onState("connecting");
    while (!stopped) {
      try {
        const res = await fetch(`/stats/${encoded}/stream`, {
          credentials: "include",
          headers: { ...auth, accept: "text/event-stream" },
          signal: controller.signal
        });
        if (res.status === 401) {
          onState("error", "stats request failed (401)");
          return;
        }
        const streaming =
          res.ok &&
          res.body !== null &&
          (res.headers.get("content-type") ?? "").includes("text/event-stream");
        if (!streaming) {
          // No stream on this deployment; poll and keep the page honest
          // about it ("polling", not "live").
          await fetchOnce();
          onState("polling");
          failures = 0;
          await sleep(POLL_INTERVAL_MS, controller.signal);
          continue;
        }
        await readStream(res);
        // Normal end of stream (the server caps connection length):
        // reconnect immediately, nothing went wrong.
        failures = 0;
      } catch (err) {
        if (stopped) {
          return;
        }
        failures++;
        try {
          await fetchOnce();
          onState("polling");
        } catch {
          onState("error", err instanceof Error ? err.message : String(err));
        }
        await sleep(
          Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS),
          controller.signal
        );
      }
    }
  }

  void run();
  return () => {
    stopped = true;
    controller.abort();
  };
}
