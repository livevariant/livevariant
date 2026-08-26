import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatsPanel } from "./components/StatsPanel";
import { parseSSE } from "./lib/stats";
import {
  analyzeSlots,
  summarizeBuckets,
  wilson95,
  type TestStats
} from "@livevariant/core";

/**
 * The live results panel in a real browser: the SSE consumption (with
 * its polling fallback), and the derived analytics the panel is built
 * on. The server side of the stream is pinned in @livevariant/server's
 * app.spec; these run against stubbed streams.
 */

let roots: Root[] = [];
let containers: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) {
    root.unmount();
  }
  for (const container of containers) {
    container.remove();
  }
  roots = [];
  containers = [];
  vi.unstubAllGlobals();
});

function render(el: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(<StrictMode>{el}</StrictMode>);
  return container;
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition never became true");
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function payload(overrides: Partial<TestStats> = {}): TestStats {
  return {
    testId: "t".repeat(64),
    totalAssignments: 120,
    combinations: [
      {
        cell: 0,
        choice: ["control"],
        pulls: 40,
        conversions: 2,
        rewardTotal: 2,
        conversionRate: 0.05
      },
      {
        cell: 1,
        choice: ["variant"],
        pulls: 80,
        conversions: 24,
        rewardTotal: 24,
        conversionRate: 0.3
      }
    ],
    slots: {
      main: [
        { name: "control", pulls: 40, conversions: 2, conversionRate: 0.05 },
        { name: "variant", pulls: 80, conversions: 24, conversionRate: 0.3 }
      ]
    },
    buckets: {
      // Sized past MIN_BUCKET_PULLS_TO_CALL on purpose: below it a bucket is
      // reported without a leader, so a smaller fixture would be testing the
      // gate rather than the labeling this case is about. The opaque bucket
      // additionally has to OUT-ARGUE partial pooling: its analysis carries
      // the whole test's rates as a 200-pseudo-observation prior, so a
      // bucket that contradicts the global lean (control wins here, variant
      // wins everywhere else) needs sustained local evidence before the
      // summary believes it. 400 starved-arm pulls at zero conversions is
      // that; the 100 this fixture used to hold is deliberately not.
      ["a".repeat(64)]: {
        pulls: [400, 1200],
        conversions: [40, 480],
        label: "country=nl"
      },
      ["b".repeat(64)]: { pulls: [800, 400], conversions: [160, 0] }
    },
    bySignal: {
      country: {
        nl: { pulls: 400, conversions: 130 },
        de: { pulls: 300, conversions: 40 }
      }
    },
    perSource: { ["c".repeat(64)]: 90, ["d".repeat(64)]: 30 },
    excluded: { total: 5, bySource: 5, byWindow: 0 },
    ...overrides
  };
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

describe("parseSSE", () => {
  it("splits complete events and keeps the unfinished tail", () => {
    const one = parseSSE('event: stats\ndata: {"a":1}\n\nevent: pi');
    expect(one.events).toEqual([{ event: "stats", data: '{"a":1}' }]);
    expect(one.rest).toBe("event: pi");
    // The tail completes on the next chunk, as it would over the wire.
    const two = parseSSE(one.rest + "ng\ndata: \n\n");
    expect(two.events).toEqual([{ event: "ping", data: "" }]);
    expect(two.rest).toBe("");
  });

  it("joins multi-line data the SSE way", () => {
    const { events } = parseSSE("data: one\ndata: two\n\n");
    expect(events[0]).toEqual({ event: "message", data: "one\ntwo" });
  });
});

describe("derived analytics", () => {
  it("wilson95 tightens with evidence and stays inside [0,1]", () => {
    const [thinLo, thinHi] = wilson95(1, 4);
    const [deepLo, deepHi] = wilson95(25, 100);
    expect(thinHi - thinLo).toBeGreaterThan(deepHi - deepLo);
    expect(thinLo).toBeGreaterThanOrEqual(0);
    expect(thinHi).toBeLessThanOrEqual(1);
    expect(wilson95(0, 0)).toEqual([0, 1]);
  });

  it("names the slot leader and shares out the traffic", () => {
    const [slot] = analyzeSlots(payload());
    expect(slot.leader).toBe(1);
    expect(slot.variants[1].probabilityBest).toBeGreaterThan(0.9);
    expect(slot.variants[0].share + slot.variants[1].share).toBeCloseTo(1);
  });

  it("finds each bucket's own winner, labeled or not", () => {
    const { top, hidden } = summarizeBuckets(payload());
    // Sorted by pulls: the nl bucket (1600) ahead of the opaque one (1200).
    expect(top[0].name).toBe("country=nl");
    expect(top[0].leader).toBe("variant");
    // The opaque bucket leans the OTHER way: control converts there.
    expect(top[1].labeled).toBe(false);
    expect(top[1].leader).toBe("control");
    expect(hidden).toBe(0);
  });

  it("reports a thin bucket's counts but refuses to call a winner in it", () => {
    // The measured reason: with every segment and variant on an identical
    // rate, 52.7% of 8x2 runs still showed a bucket at P(best) >= 95%.
    const thin = payload();
    thin.buckets = {
      ["c".repeat(64)]: {
        pulls: [20, 20],
        conversions: [0, 6],
        label: "country=be"
      }
    };
    const { top } = summarizeBuckets(thin);
    expect(top[0].pulls).toBe(40);
    expect(top[0].conversions).toBe(6);
    expect(top[0].leader).toBeNull();
    expect(top[0].probabilityBest).toBeNull();
  });

  it("spends the posterior work only on the buckets it will show", () => {
    // Ranking is cheap totals; analysis past the display cap is waste.
    const { top, hidden } = summarizeBuckets(payload(), 1);
    expect(top).toHaveLength(1);
    expect(top[0].name).toBe("country=nl");
    expect(hidden).toBe(1);
  });
});

describe("the live panel", () => {
  it("streams: renders, shows LIVE, and ticks when an update arrives", async () => {
    let push: ((chunk: Uint8Array) => void) | null = null;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/stream")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sse("stats", payload()));
            push = chunk => controller.enqueue(chunk);
          }
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      return Response.json(payload());
    });

    const container = render(
      <StatsPanel encoded="enc" statsSecret="secret" hasSecret={true} />
    );
    await until(() => container.textContent?.includes("LIVE") ?? false);
    expect(container.textContent).toContain("120");
    // The slot table, with its posterior verdict column.
    expect(container.textContent).toContain("P(best)");
    expect(container.textContent).toContain("variant leads");
    expect(container.textContent).toContain("still testing");
    // Buckets: the labeled one readable, the opaque one shortened.
    expect(container.textContent).toContain("country=nl");
    expect(container.textContent).toContain("bbbbbbbb…");
    // Signals show; traffic sources deliberately do not (opaque rotating
    // hashes, twice misread as a bug), while the exclusion audit line stays.
    expect(container.textContent).toContain("audience signals");
    expect(container.textContent).not.toContain("traffic sources");
    expect(container.textContent).not.toContain("cccccccccccc");
    expect(container.textContent).toContain("5 assignments excluded");

    // A second event over the same connection updates the numbers.
    push!(sse("stats", payload({ totalAssignments: 121 })));
    await until(() => container.textContent?.includes("121") ?? false);
  });

  it("falls back to polling when the deployment has no stream", async () => {
    vi.stubGlobal("fetch", async () => Response.json(payload()));
    const container = render(
      <StatsPanel encoded="enc" statsSecret="secret" hasSecret={true} />
    );
    await until(() => container.textContent?.includes("polling") ?? false);
    expect(container.textContent).toContain("120");
    expect(container.textContent).not.toContain("LIVE");
  });

  it("treats a 401 as terminal and explains the missing secret", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    const container = render(
      <StatsPanel encoded="enc" statsSecret={null} hasSecret={false} />
    );
    await until(
      () => container.textContent?.includes("Could not load stats") ?? false
    );
    expect(container.textContent).toContain("#secret");
  });
});
