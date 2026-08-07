import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { createTest, type LiveTest } from "@livevariant/sdk";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchDeploymentConfig, useServeUrl } from "@/lib/serve-url";
import { InstallCard } from "@/components/InstallCard";

/**
 * The marketing page, implementing DESIGN.md's approved composition
 * (round9): headline, the conversation that plans and builds the demo
 * test beside the email window running it (scenes cycle in the hero
 * slot, labels in the button slot), the per-segment streamgraph (lanes
 * are segments, bands are variants), one URL, the skills-first install
 * card, the scoreboard, and the AGPL/deploy closer. Midnight theme is
 * scoped here; the builder stays light.
 *
 * The hero headline and subline are served by a REAL LiveVariant test
 * (see PAGE_TEST below) through the SDK: on the deployed Worker it
 * chooses per visitor with country and device dims, and clicking the
 * "Create a test" CTA is the conversion. When no server answers (local
 * dev), the SDK renders the control and records nothing, which is its
 * documented fallback. The streamgraph's numbers remain illustrative
 * until /stats is wired via a stats key.
 */

const VARIANT_COLORS = [
  "var(--variant-a)",
  "var(--variant-b)",
  "var(--variant-c)"
];
const VARIANT_NAMES = ["A", "B", "C"] as const;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ */
/* The test running on this page. The strings are the config; the JSX
   map renders the chosen headline with DESIGN.md's italic-marks-tested
   rule. Keyless on purpose: the SDK scopes it to this hostname. */

const HEADLINES = [
  {
    text: "The test that keeps testing.",
    jsx: (
      <>
        The test that <em>keeps</em> testing.
      </>
    )
  },
  {
    text: "Let your LLM run the testing.",
    jsx: (
      <>
        Let your LLM <em>run</em> the testing.
      </>
    )
  },
  {
    text: "One URL. Every audience.",
    jsx: (
      <>
        One URL. <em>Every</em> audience.
      </>
    )
  }
];

const SUBS = [
  "Your LLM drafts the scenes, builds the test, and hands you one image URL for your newsletter or website.",
  "It drafts the variants, builds the test, and hands you one URL. You paste it. It keeps optimizing.",
  "Adaptive A/B testing for email and web that never stops learning, run by your assistant or by you."
];

const PAGE_TEST = {
  slots: {
    headline: HEADLINES.map(h => h.text),
    sub: SUBS
  },
  ctx: {
    dims: [
      { key: "country", from: "country" as const },
      { key: "device", from: "device" as const }
    ]
  }
};

interface PageTestState {
  headline: number;
  sub: number;
  fallback: boolean;
  test: LiveTest | null;
  /** False until a decision (or the fallback) is in; the hero hides
   *  itself meanwhile so nobody watches the headline switch. */
  ready: boolean;
}

function usePageTest(): PageTestState {
  const [state, setState] = useState<PageTestState>({
    headline: 0,
    sub: 0,
    fallback: true,
    test: null,
    ready: false
  });
  useEffect(() => {
    let live = true;
    let created: LiveTest | null = null;
    const reveal = () => {
      if (live) {
        setState(prev => ({ ...prev, ready: true }));
      }
    };
    void (async () => {
      try {
        const deployment = await fetchDeploymentConfig();
        // The deployment's own key makes this test OURS in the
        // dashboard. Prefer the /config copy; without one, pass no
        // serverUrl at all: createTest then waits for a tag-manager
        // loaded tag's global (which carries a key) and throws past
        // its timeout, caught below, so the control renders rather
        // than a key-less, unowned test running.
        const options = deployment.publishableKey
          ? {
              serverUrl: deployment.serveUrl,
              publishableKey: deployment.publishableKey
            }
          : {
              // No key means the only way a key arrives is a GTM-loaded
              // tag. Without GTM configured there is nothing to wait
              // for, and waiting the full tag timeout held the hero
              // invisible for seconds on dev and key-less self-hosts.
              tagWaitMs: deployment.gtmId ? undefined : (false as const)
            };
        created = await createTest(PAGE_TEST, {
          ...options,
          // Conversions are tracked manually on the CTA click; no GA
          // interception on our own page.
          rewardEvents: false
        });
        if (!live) {
          // Unmounted while awaiting: the cleanup below already ran
          // with `created` still null, so dispose here.
          created.dispose();
          return;
        }
        setState({
          headline: created.slots.headline.index,
          sub: created.slots.sub.index,
          fallback: created.fallback,
          test: created,
          ready: true
        });
      } catch {
        // The SDK already degrades to control; this catch only guards
        // the config fetch. The page must render regardless.
        reveal();
      }
    })();
    return () => {
      live = false;
      created?.dispose();
    };
  }, []);
  return state;
}

/* ------------------------------------------------------------------ */
/* The mug: one identical product, three scenes. The point of the demo
   is that the product never changes while the scene does, so the mug
   is a single shared shape. */

function Mug({ tone = "#efeae0" }: { tone?: string }) {
  return (
    <g>
      <ellipse cx="0" cy="26" rx="30" ry="5" fill="rgba(0,0,0,0.25)" />
      <path
        d="M -24 -22 L -22 22 Q -22 26 -16 26 L 16 26 Q 22 26 22 22 L 24 -22 Z"
        fill={tone}
      />
      <path
        d="M 23 -12 Q 40 -12 40 2 Q 40 16 21 15"
        fill="none"
        stroke={tone}
        strokeWidth="7"
      />
      <ellipse cx="0" cy="-22" rx="24" ry="6" fill="#d9d2c4" />
      <text
        x="0"
        y="6"
        textAnchor="middle"
        fontSize="5.5"
        fontFamily="Commit Mono, monospace"
        fill="#6b6558"
      >
        daily brew
      </text>
    </g>
  );
}

function Scene({ scene }: { scene: number }) {
  return (
    <svg
      viewBox="0 0 320 150"
      className="h-full w-full"
      role="img"
      aria-label={`Scene variant ${VARIANT_NAMES[scene]}`}
    >
      {scene === 0 && (
        /* A: packshot on studio paper */
        <g>
          <rect width="320" height="150" fill="#e8e4db" />
          <rect y="112" width="320" height="38" fill="#ddd8cc" />
          <g transform="translate(160,78)">
            <Mug />
          </g>
        </g>
      )}
      {scene === 1 && (
        /* B: cafe table by a window */
        <g>
          <rect width="320" height="150" fill="#3d3227" />
          <rect width="320" height="96" fill="#54432f" />
          <circle cx="58" cy="42" r="22" fill="#6d5335" opacity="0.7" />
          <circle cx="270" cy="30" r="16" fill="#6d5335" opacity="0.5" />
          <rect y="96" width="320" height="54" fill="#7a5c38" />
          <rect y="96" width="320" height="4" fill="#8f6c42" />
          <g transform="translate(150,86)">
            <Mug tone="#f3ede1" />
          </g>
          <rect x="228" y="104" width="52" height="8" rx="3" fill="#5c4426" />
        </g>
      )}
      {scene === 2 && (
        /* C: fireside, wool blanket */
        <g>
          <rect width="320" height="150" fill="#1c1410" />
          <circle cx="252" cy="66" r="46" fill="#5a2f14" opacity="0.8" />
          <circle cx="252" cy="70" r="30" fill="#a4561c" opacity="0.8" />
          <circle cx="252" cy="74" r="16" fill="#e08a3c" opacity="0.9" />
          <g transform="translate(0,108)">
            <rect width="320" height="42" fill="#40342a" />
            <rect y="8" width="320" height="4" fill="#4c3f33" />
            <rect y="20" width="320" height="4" fill="#4c3f33" />
          </g>
          <g transform="translate(120,88)">
            <Mug tone="#eee6d6" />
          </g>
        </g>
      )}
    </svg>
  );
}

/* The two slots of the demo test the conversation below plans: the
   hero scene (the three Scene drawings) and the email's button. Shared
   by the chat and the email window so the story stays one test. */

const SCENE_LABELS = ["packshot", "cafe", "fireside"] as const;
const CTA_VARIANTS = [
  "Shop the roast",
  "Start your ritual",
  "Brew better today"
] as const;

/* ------------------------------------------------------------------ */

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <h2 className="font-display text-3xl sm:text-4xl">{title}</h2>
      {sub && <p className="mt-3 text-muted-foreground">{sub}</p>}
    </div>
  );
}

function EmailWindow() {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(1);
  const [cta, setCta] = useState(1);
  useEffect(() => {
    if (reduced) {
      return;
    }
    const id = setInterval(() => setActive(current => (current + 1) % 3), 5000);
    // The button is the second slot: its own cadence, deliberately out
    // of phase with the scenes, so the COMBINATION visibly changes.
    const ctaId = setInterval(() => setCta(current => (current + 1) % 3), 7000);
    return () => {
      clearInterval(id);
      clearInterval(ctaId);
    };
  }, [reduced]);

  return (
    <figure className="m-0">
      <Card className="overflow-hidden border-border bg-card py-0 shadow-none">
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-3">
          <span className="size-2.5 rounded-full bg-[#f87171]" />
          <span className="size-2.5 rounded-full bg-[#fbbf24]" />
          <span className="size-2.5 rounded-full bg-[#34d399]" />
          <span className="ml-3 font-mono text-xs text-muted-foreground">
            inbox
          </span>
        </div>
        <CardContent className="space-y-3 px-4 pb-4 pt-3">
          <p className="border-b border-border pb-2 font-mono text-xs text-muted-foreground">
            Subject:{" "}
            <span className="text-foreground">Brew better, daily.</span>
          </p>
          <p className="text-sm text-muted-foreground">
            Hey there, a better cup starts with one small change. Here is what
            we are brewing this week.
          </p>
          <div className="relative aspect-[320/150] overflow-hidden rounded-md">
            {[0, 1, 2].map(scene => (
              <div
                key={scene}
                className="absolute inset-0 transition-opacity duration-700"
                style={{ opacity: scene === active ? 1 : 0 }}
              >
                <Scene scene={scene} />
              </div>
            ))}
            <span className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full border border-live/40 bg-background/80 px-2 py-0.5 font-mono text-xs text-live">
              <span className="live-dot size-1.5 rounded-full bg-live" />
              LIVE · {VARIANT_NAMES[active]}
            </span>
          </div>
          <div className="flex justify-center py-1">
            <span className="relative inline-grid rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
              {CTA_VARIANTS.map((label, variant) => (
                <span
                  key={label}
                  aria-hidden={variant !== cta}
                  className="col-start-1 row-start-1 whitespace-nowrap text-center transition-opacity duration-700"
                  style={{ opacity: variant === cta ? 1 : 0 }}
                >
                  {label}
                </span>
              ))}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {[0, 1, 2].map(scene => (
              <button
                key={scene}
                type="button"
                onClick={() => setActive(scene)}
                aria-label={`Show scene ${VARIANT_NAMES[scene]}`}
                className="h-9 w-14 overflow-hidden rounded border-2 transition-opacity"
                style={{
                  borderColor:
                    scene === active ? VARIANT_COLORS[scene] : "var(--border)",
                  opacity: scene === active ? 1 : 0.55
                }}
              >
                <Scene scene={scene} />
              </button>
            ))}
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              hero {VARIANT_NAMES[active].toLowerCase()} · cta{" "}
              {VARIANT_NAMES[cta].toLowerCase()}
            </span>
          </div>
        </CardContent>
      </Card>
      <figcaption className="sr-only">
        The email window's image slot cycles through the three drafted scenes
        while the button cycles its three labels: one test, two slots, nine
        combinations.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* The conversation that creates the test. Scripted and honest about
   the flow the skill teaches agents: propose a plan (two slots, named
   variants), wait for the human's yes, only then build. It plays once
   when scrolled into view and ends in a live state; reduced motion
   shows the finished conversation. */

interface ChatMessageProps {
  from: "you" | "assistant";
  children: ReactNode;
}

function ChatMessage({ from, children }: ChatMessageProps) {
  const you = from === "you";
  return (
    <div className={`chat-enter ${you ? "ml-auto max-w-[85%]" : "max-w-full"}`}>
      <p
        className={`mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground ${
          you ? "text-right" : ""
        }`}
      >
        {from}
      </p>
      <div
        className={`space-y-3 rounded-lg px-3.5 py-2.5 text-sm ${
          you
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-background/40"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function ChatTyping() {
  return (
    <div className="chat-enter">
      <div className="inline-flex items-center gap-1 rounded-lg border border-border px-3.5 py-3">
        {[0, 1, 2].map(dot => (
          <span
            key={dot}
            className="chat-typing-dot size-1.5 rounded-full bg-muted-foreground"
          />
        ))}
      </div>
    </div>
  );
}

/* What a two-slot email test really hands back: one serve link per
   slot (each goes in its element's <img>) and the click link that
   records the win and redirects. The encoded config is elided to a
   base64-looking stub so the lines stay readable. */
const BUILT_LINKS = [
  {
    label: "img hero",
    url: "livevariant.link/s/eyJz…?slot=hero&id={{email_or_any_id}}&auto=0"
  },
  {
    label: "img cta",
    url: "livevariant.link/s/eyJz…?slot=cta&id={{email_or_any_id}}&auto=0"
  },
  { label: "click", url: "livevariant.link/c/eyJz…?id={{email_or_any_id}}" },
  { label: "manage", url: "livevariant.com/manage/eyJz…#kq4xw…" }
];

/** Message count when the whole conversation is on screen. */
const CHAT_DONE = 4;

function ChatFlow() {
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(0);
  const [typing, setTyping] = useState(false);
  const [started, setStarted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduced) {
      setStep(CHAT_DONE);
      setTyping(false);
      return;
    }
    if (!started) {
      return;
    }
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) =>
      timers.push(window.setTimeout(fn, ms));
    at(400, () => setStep(1));
    at(1000, () => setTyping(true));
    at(2600, () => {
      setTyping(false);
      setStep(2);
    });
    at(5600, () => setStep(3));
    at(6200, () => setTyping(true));
    at(7400, () => {
      setTyping(false);
      setStep(CHAT_DONE);
    });
    return () => timers.forEach(id => clearTimeout(id));
  }, [started, reduced]);

  return (
    <figure className="m-0" ref={rootRef}>
      <Card className="overflow-hidden border-border bg-card py-0 shadow-none">
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-3">
          <span className="size-2.5 rounded-full bg-[#f87171]" />
          <span className="size-2.5 rounded-full bg-[#fbbf24]" />
          <span className="size-2.5 rounded-full bg-[#34d399]" />
          <span className="ml-3 font-mono text-xs text-muted-foreground">
            your assistant
          </span>
        </div>
        <div
          role="log"
          aria-label="Example conversation that sets up the test"
          className="space-y-4 px-4 py-4"
        >
          {step >= 1 && (
            <ChatMessage from="you">
              <p>
                I want to A/B test my next "Daily brew" newsletter with
                livevariant.com. Give me some ideas and set it up.
              </p>
            </ChatMessage>
          )}
          {step >= 2 && (
            <ChatMessage from="assistant">
              <p>
                Two things are worth testing together here: the hero scene and
                the button. One test, two slots, so it learns the winning
                combination instead of two separate answers.
              </p>
              <div className="space-y-1.5">
                <p className="font-mono text-xs text-muted-foreground">
                  slot: hero
                </p>
                <div className="flex gap-2">
                  {SCENE_LABELS.map((name, scene) => (
                    <figure key={name} className="m-0 w-16">
                      <div
                        className="h-9 overflow-hidden rounded border-b-2"
                        style={{ borderColor: VARIANT_COLORS[scene] }}
                      >
                        <Scene scene={scene} />
                      </div>
                      <figcaption className="mt-1 text-center font-mono text-[10px] text-muted-foreground">
                        {name}
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  I drafted three scenes. The mug never changes; the scene does.
                </p>
              </div>
              <div className="space-y-1.5">
                <p className="font-mono text-xs text-muted-foreground">
                  slot: cta
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                  {CTA_VARIANTS.map((label, variant) => (
                    <span
                      key={label}
                      className="border-b-2 pb-0.5 font-mono text-xs"
                      style={{ borderColor: VARIANT_COLORS[variant] }}
                    >
                      "{label}"
                    </span>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="font-mono text-xs text-muted-foreground">
                  ctx: utm_source · country (merge tag)
                </p>
              </div>
              <p>
                Nine combinations, sticky per reader via your merge tag, clicks
                count as the win, and a different combination can win per
                audience. Build it?
              </p>
            </ChatMessage>
          )}
          {step >= 3 && (
            <ChatMessage from="you">
              <p>Looks good!</p>
            </ChatMessage>
          )}
          {step >= CHAT_DONE && (
            <ChatMessage from="assistant">
              <p>
                Built. Three links for the template (one image link per slot,
                and the click link that records the win and redirects), plus
                your manage link.
              </p>
              <div className="overflow-x-auto rounded bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed">
                {BUILT_LINKS.map(link => (
                  <p key={link.label} className="whitespace-nowrap">
                    <span className="text-muted-foreground">
                      {link.label.padEnd(9)}
                    </span>
                    {link.url}
                  </p>
                ))}
              </div>
              <p className="text-muted-foreground">
                The manage link shows live results in the browser and saves the
                test to a dashboard in one click; it carries your stats secret,
                so share it only with people who may see results.
              </p>
              <p>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-live/40 px-2 py-0.5 font-mono text-xs text-live">
                  <span className="live-dot size-1.5 rounded-full bg-live" />
                  LIVE · 9 combinations · still testing
                </span>
              </p>
            </ChatMessage>
          )}
          {typing && <ChatTyping />}
        </div>
      </Card>
      <figcaption className="sr-only">
        An example conversation: you ask for ideas, the assistant proposes a
        hero and a button slot with three variants each, you approve, and the
        test goes live.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* The streamgraph. Semantics from DESIGN.md: each LANE is an audience
   segment; the three BANDS inside a lane are the variants sharing that
   segment's traffic. Widths drift to say "still deciding, forever". */

/* The same segments the conversation above configures (ctx:
   utm_source plus the country merge tag), so the page tells one test's
   story end to end. */
const LANES = [
  {
    label: "utm_source: newsletter",
    weights: [0.28, 0.52, 0.2],
    speed: 0.9
  },
  { label: "utm_source: blog", weights: [0.42, 0.3, 0.28], speed: 1.15 },
  { label: "country: DE (merge tag)", weights: [0.22, 0.34, 0.44], speed: 0.75 }
];
const POINTS = 44;
/* One coordinate space for all three lanes, so they can physically bend
   into the shared LIVE dot at the right edge. */
const GRAPH_W = 800;
const GRAPH_H = 360;
const LANE_CENTERS = [60, 180, 300];
const LANE_HALF = 36;
const CONVERGE_FROM = 0.62;

function smoothstep(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

function lanePaths(
  lane: (typeof LANES)[number],
  laneIndex: number,
  t: number
): string[] {
  const boundaries: number[][] = [[], [], [], []];
  for (let i = 0; i <= POINTS; i++) {
    const x01 = i / POINTS;
    // Past CONVERGE_FROM the lane's centerline bends toward the graph's
    // vertical middle and its height collapses, so all three lanes meet
    // in the LIVE dot.
    const bend = smoothstep((x01 - CONVERGE_FROM) / (1 - CONVERGE_FROM));
    const center =
      LANE_CENTERS[laneIndex] + (GRAPH_H / 2 - LANE_CENTERS[laneIndex]) * bend;
    const half = Math.max(1.2, LANE_HALF * (1 - 0.97 * bend));
    const raw = lane.weights.map((w, k) =>
      Math.max(
        0.08,
        w *
          (1 +
            0.38 *
              Math.sin(
                x01 * (5.2 + k * 1.7) +
                  t * lane.speed * (0.6 + k * 0.35) +
                  k * 2.1
              ))
      )
    );
    const total = raw[0] + raw[1] + raw[2];
    let acc = 0;
    boundaries[0].push(center - half);
    for (let k = 0; k < 3; k++) {
      acc += raw[k] / total;
      boundaries[k + 1].push(center - half + acc * 2 * half);
    }
  }
  const xAt = (i: number) => (i / POINTS) * GRAPH_W;
  return [0, 1, 2].map(k => {
    const top = boundaries[k].map(
      (y, i) => `${xAt(i).toFixed(1)},${y.toFixed(2)}`
    );
    const bottom = boundaries[k + 1]
      .map((y, i) => `${xAt(i).toFixed(1)},${y.toFixed(2)}`)
      .reverse();
    return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
  });
}

function Streamgraph() {
  const reduced = usePrefersReducedMotion();
  const [t, setT] = useState(2.4);
  const frame = useRef(0);
  useEffect(() => {
    if (reduced) {
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      // ~30fps is plenty for a slow drift and kind to batteries.
      if (now - last > 33) {
        setT(current => current + (now - last) / 4000);
        last = now;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [reduced]);

  return (
    <figure className="m-0">
      <div className="flex items-stretch gap-4">
        <div className="relative w-40 shrink-0">
          {LANES.map((lane, laneIndex) => (
            <span
              key={lane.label}
              className="absolute right-0 w-full -translate-y-1/2 text-right font-mono text-xs text-muted-foreground"
              style={{ top: `${(LANE_CENTERS[laneIndex] / GRAPH_H) * 100}%` }}
            >
              {lane.label}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
          preserveAspectRatio="none"
          className="h-56 w-full min-w-0 flex-1 sm:h-64"
          aria-hidden="true"
        >
          {LANES.map((lane, laneIndex) =>
            lanePaths(lane, laneIndex, t + laneIndex * 3.7).map((d, k) => (
              <path
                key={`${laneIndex}-${k}`}
                d={d}
                fill={VARIANT_COLORS[k]}
                opacity={0.9}
              />
            ))
          )}
        </svg>
        <div className="flex shrink-0 items-center">
          <span className="inline-flex -translate-x-1.5 items-center gap-1.5 font-mono text-xs text-live">
            <span className="live-dot size-3 rounded-full bg-live" />
            LIVE
          </span>
        </div>
      </div>
      <figcaption className="sr-only">
        Three variant bands competing inside each audience segment lane.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

/* Tiny dependency-free highlighter for the one snippet on this page.
   Restrained per DESIGN.md: soft green keywords, parchment strings,
   muted comments; and the three headline strings are tinted in their
   own variant colors, because they ARE the variants. */

const SYNTAX = {
  keyword: "var(--code-keyword)",
  string: "var(--code-string)",
  punct: "var(--code-punct)"
};

const CODE_TOKEN =
  /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|(\b(?:import|from|const|await)\b)/g;

function CodeBlock({ code }: { code: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of code.matchAll(CODE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) {
      nodes.push(code.slice(last, index));
    }
    const [text, comment, str, keyword] = match;
    if (comment !== undefined) {
      nodes.push(
        <span key={key++} style={{ color: SYNTAX.punct }}>
          {text}
        </span>
      );
    } else if (str !== undefined) {
      const variantIndex = HEADLINES.findIndex(
        h => JSON.stringify(h.text) === text
      );
      nodes.push(
        <span
          key={key++}
          style={{
            color:
              variantIndex >= 0 ? VARIANT_COLORS[variantIndex] : SYNTAX.string
          }}
        >
          {text}
        </span>
      );
    } else if (keyword !== undefined) {
      nodes.push(
        <span key={key++} style={{ color: SYNTAX.keyword }}>
          {text}
        </span>
      );
    }
    last = index + text.length;
  }
  nodes.push(code.slice(last));
  return (
    <pre className="overflow-x-auto font-mono text-sm leading-relaxed">
      <code>{nodes}</code>
    </pre>
  );
}

function PageTestSnippet({
  serveUrl,
  pageTest
}: {
  serveUrl: string;
  pageTest: PageTestState;
}) {
  const snippet = `import { createTest } from "@livevariant/sdk";

const test = await createTest(
  {
    slots: {
      headline: [
${HEADLINES.map(h => `        ${JSON.stringify(h.text)}`).join(",\n")}
      ],
      sub: [/* three more variants */]
    },
    ctx: {
      dims: [
        { key: "country", from: "country" },
        { key: "device", from: "device" }
      ]
    }
  },
  { serverUrl: "${serveUrl}" }
);

headline.textContent = test.slots.headline.text;
sub.textContent = test.slots.sub.text;`;
  return (
    <Card className="border-border bg-card shadow-none">
      <CardContent className="space-y-3 pt-6">
        <p className="font-mono text-xs text-muted-foreground">
          the test running on this page
        </p>
        <p className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm">
          <span className="text-muted-foreground">$ </span>npm i
          @livevariant/sdk
        </p>
        <CodeBlock code={snippet} />
        <p className="text-sm text-muted-foreground">
          {pageTest.fallback ? (
            <span className="font-mono text-xs">
              (no server answered here, so you are reading the control)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs text-live">
              <span className="live-dot inline-block size-1.5 rounded-full bg-live" />
              this headline is variant {VARIANT_NAMES[pageTest.headline]}, still
              testing
            </span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

const DEMO_URL = {
  base: "https://livevariant.link/s?",
  parts: [
    { text: "s=hero", color: undefined },
    { text: "&" },
    { text: "v=a.jpg", color: VARIANT_COLORS[0] },
    { text: "&" },
    { text: "v=b.jpg", color: VARIANT_COLORS[1] },
    { text: "&" },
    { text: "v=c.jpg", color: VARIANT_COLORS[2] }
  ]
};

export function Landing() {
  const serveUrl = useServeUrl();
  const pageTest = usePageTest();

  return (
    <>
      <section className="pb-16 pt-14 text-center sm:pt-20">
        {/* Invisible (not unmounted) until the test decides: the space
            is reserved, and nobody sees the control flip to the chosen
            variant. */}
        <div
          className={`transition-opacity duration-300 ${
            pageTest.ready ? "opacity-100" : "opacity-0"
          }`}
        >
          <h1 className="font-display text-[clamp(3rem,8.5vw,6.75rem)] leading-[1.02] tracking-tight">
            {HEADLINES[pageTest.headline].jsx}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            {SUBS[pageTest.sub]}
          </p>
        </div>
      </section>

      <section className="border-t border-border py-14">
        <SectionTitle
          title="The whole setup is one conversation."
          sub="Ask for ideas, approve the plan, and the newsletter is testing: a hero slot and a button slot, learned as one combination."
        />
        <div className="mx-auto mt-12 max-w-2xl">
          <ChatFlow />
        </div>
      </section>

      <section className="border-t border-border py-14">
        <SectionTitle
          title="The newsletter, running the test it just built."
          sub="The hero and the button keep testing as one combination, and every reader sticks to theirs."
        />
        <div className="mx-auto mt-12 max-w-2xl">
          <EmailWindow />
        </div>
      </section>

      <section className="border-t border-border py-14">
        <SectionTitle
          title="It keeps testing, for every audience."
          sub="Three variants, competing inside the audience segments the assistant configured, forever."
        />
        <div className="mx-auto mt-12 max-w-5xl">
          <Streamgraph />
        </div>
      </section>

      <section className="border-t border-border py-14 text-center">
        <SectionTitle
          title="The whole test lives in the URL."
          sub="Paste it in your newsletter or website; every recipient sticks to their combination, and it keeps optimizing."
        />
        <p className="mt-10 overflow-x-auto whitespace-nowrap pb-1 font-mono text-sm sm:text-xl">
          {DEMO_URL.base}
          {DEMO_URL.parts.map((part, i) => (
            <span
              key={i}
              style={part.color ? { color: part.color } : undefined}
            >
              {part.text}
            </span>
          ))}
        </p>
      </section>

      <section className="border-t border-border py-14">
        <SectionTitle title="Have your LLM create the tests." />
        <div className="mx-auto mt-12 max-w-3xl">
          <InstallCard
            onConvert={() => {
              // Copying an install command is the LLM-path conversion.
              void pageTest.test?.trackConversion();
            }}
          />
        </div>
        <div className="mt-12 text-center">
          <p className="font-mono text-xs text-muted-foreground">
            or do it manually
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" asChild>
              <Link
                to="/builder"
                onClick={() => {
                  // The page test's conversion: the visitor went on to
                  // create a test. Fire and forget; navigation wins.
                  void pageTest.test?.trackConversion();
                }}
              >
                Create a test <ArrowRight />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              asChild
            >
              <a
                href="https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant"
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  void pageTest.test?.trackConversion();
                }}
              >
                Deploy your own
              </a>
            </Button>
          </div>
        </div>
      </section>

      <section className="border-t border-border py-14">
        <SectionTitle
          title="Test your website, too."
          sub="Install the SDK, or point your coding agent at it, and test images and content directly on the page: headlines, heroes, whole sections, per country and device. This page is a test, too; the code below is running right now."
        />
        <div className="mx-auto mt-12 max-w-3xl">
          <PageTestSnippet serveUrl={serveUrl} pageTest={pageTest} />
        </div>
      </section>

      <section className="border-t border-border py-14 text-center">
        <SectionTitle
          title="This product is designed to deploy yourself."
          sub="Our server can be used for testing, but its state can be destroyed at any time. We are working on a hosted version."
        />
        <div className="mt-8 flex justify-center">
          <Button size="lg" asChild>
            <a
              href="https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant"
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                void pageTest.test?.trackConversion();
              }}
            >
              Deploy your own <ArrowRight />
            </a>
          </Button>
        </div>
      </section>
    </>
  );
}
