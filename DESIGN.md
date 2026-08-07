# Design System — LiveVariant

The source of truth for every visual decision on livevariant.com and in
the README. Read this before touching any UI. The approved composition
reference is the mockup at
`~/.gstack/projects/livevariant-livevariant/designs/design-system-20260804/round9-final.png`
(plus `approved.json` beside it); when this document and old code
disagree, this document wins.

## Product Context

- **What this is:** open-source (AGPL) adaptive A/B testing where the
  whole test lives in a URL; one joint model keeps testing forever, per
  audience segment, across several slots at once.
- **Who it's for:** LLM agents and their users first, email marketers
  second, developers third. All three touch the same object: the URL.
- **Space/peers:** dev-tool landing pages (PostHog, Resend, GrowthBook,
  Plausible). We deliberately do NOT look like the experimentation
  platforms: no dashboards, no seats, no platform gravity.
- **Project type:** marketing site + account-free builder (apps/web),
  plus README as the repo's storefront.

## The Memorable Thing

**"The test that keeps testing."** Every design decision serves this:
the page itself runs a live test on its own hero, motion implies
continuation (never completion), and nothing on the page ever reads as
"finished". Ease ("swap one URL", "let your LLM do it") is the
supporting act, never the headline.

## Aesthetic Direction

- **Direction:** Midnight Editorial. Near-black page, oversized literary
  serif, mono for everything the machine touches, one live accent.
- **Decoration level:** minimal. Thin hairline rules, generous black
  space, zero ornament. No gradients, no blobs, no glassmorphism, no
  icon grids, no dashboard screenshots, no stock photos outside the
  product-demo imagery itself.
- **Mood:** a quiet instrument that happens to be running; serious,
  literary, slightly nocturnal. "This thing is alive and betting on
  itself."
- **Reference sites:** resend.com (dark restraint), plausible.io
  (honest simplicity), posthog.com (install-command-in-hero pattern
  only). GrowthBook is the anti-reference.

## Typography

- **Display/Hero:** Instrument Serif 400 + Italic — literary confidence
  no other dev tool in the category uses; free and self-hostable.
  **Rule: italic is reserved for words currently under live test** (the
  "keeps" in the headline). Never italicize decoratively.
- **Body/UI:** General Sans (Fontshare) 400/500, 600 for buttons.
- **Data/URLs/Code:** Commit Mono 400/500 — the star of the system,
  because the product IS a URL. Tabular numerals for all metrics.
- **Loading:** self-host via @font-face (AGPL repo must not depend on
  third-party font CDNs). Subset woff2.
- **Scale:** display clamp(56px, 9vw, 120px); h2 32px; body 17px;
  captions 14px; mono 15px (URL strip up to 20px when it is the focal
  object). Line-height 1.05 display, 1.6 body.

## Color

- **Approach:** restrained, with a strict role system. Color always
  MEANS something; nothing is tinted for looks.
- **Background:** `#0A0A0A` near-black. Surfaces `#141414`, hairlines
  `#262626`.
- **Text:** `#F5F2EC` off-white; muted `#8A8578`.
- **Live accent:** `#34D399` spring green. RESERVED for liveness: LIVE
  dots, "still testing", the active tab underline, the live chip.
  Never decorative, never on static elements.
- **Variant colors, reserved system-wide for variant identity only:**
  A `#60A5FA` blue, B `#FB923C` orange, C `#A78BFA` violet. Used as
  thin underlines, URL parameter tints, chart bands, scoreboard
  figures. Never for buttons, links, or decoration.
- **Semantic:** success = live green above; warning `#FBBF24`; error
  `#F87171`; links = off-white with underline (color is not spent on
  links).
- **Light mode (daylight):** the slip-paper twin, system-preference by
  default with a persisted header toggle. Background `#F6F1E7`, surface
  `#FFFDF7`, ink `#1A1F1B`, muted `#6E6A5E`, border `#E0D9C8`; variant
  inks deepen for contrast (A `#2456E6`, B `#E8590C`, C `#7C3AED`) and
  live green becomes bookmaker `#0E7A55`. Same role rules apply in both
  themes; both are shadcn variable scopes (`.midnight` / `.daylight`).

## Spacing

- **Base unit:** 8px.
- **Density:** spacious on marketing (sections breathe 96 to 160px
  apart), comfortable in the builder.
- **Scale:** xs(4) sm(8) md(16) lg(24) xl(40) 2xl(64) 3xl(96) 4xl(160).

## Layout

- **Approach:** poster-first, one focal artifact per viewport, never
  stacked marketing cards. Full-width bands separated by hairlines.
- **Grid:** 12-col, max content width 1200px, generous side margins.
- **Border radius:** 8px on cards/code blocks, 999px only on tiny live
  chips. Nothing else is rounded.

## Motion

- **Approach:** intentional; "decision systems, not confetti". Motion
  exists to say "still running".
- The email window's image slot cross-fades through the three scene
  variants on a slow cycle (5s per scene), pager dot follows.
- The streamgraph bands drift continuously (springy width shifts every
  ~600ms eased, ~60s loop, no visible restart); the LIVE dot pulses
  gently.
- Scoreboard numbers tick with a short odometer roll when they change.
- Nothing bounces, floats, or parallaxes. `prefers-reduced-motion`:
  freeze everything at a representative mid-state, keep the LIVE dot
  static green.
- **Easing:** enter ease-out 200ms; move ease-in-out 300ms; band
  drift spring(1, 80, 12).

## Content Architecture (approved composition, round9-final)

1. **Nav:** wordmark, GitHub, Docs, "Deploy your own" (outlined).
2. **Hero:** giant serif "The test that _keeps_ testing." + one
   subline: "Your LLM drafts the scenes, builds the test, and hands you
   one URL for your newsletter."
3. **First band, the conversation above the email window:** a chat
   window playing the scripted setup conversation once when it scrolls
   into view, growing as messages arrive (no inner scroll): ask for
   ideas; the assistant proposes two slots, `hero` with the three
   scene thumbnails and `cta` with three button labels, each
   underlined in its variant color, plus a `ctx: utm_source · country
(merge tag)` line; "Looks good!"; built, handing back the three
   template links (serve per slot, click redirect) and a pulsing LIVE
   chip, with the manage link listed among the returned links. Then
   its own band, headed "The newsletter, running the test it just
   built.": the email window running that test, a minimal mail client
   whose hero-image slot cycles the three assistant-drafted scenes (A
   packshot / B cafe / C fireplace) on a 5s cycle while the CTA button
   cycles its three labels out of phase (7s), filmstrip pager
   underlined in variant colors, green `LIVE - B` chip, mono
   combination readout (`hero b - cta c`). Reduced motion: the
   finished conversation, statically.
4. **The living streamgraph:** three horizontal SEGMENT lanes matching
   the conversation's ctx (`utm_source: newsletter`, `utm_source:
blog`, `country: DE (merge tag)`), each lane internally sharing its
   height between the
   three VARIANT bands (blue/orange/violet), widths drifting over a
   -7d to now axis, all lanes converging into one pulsing LIVE dot.
   Caption: "three variants, competing inside every audience segment,
   forever." **Semantics rule: lanes are segments, bands are variants.
   Never color a lane by variant.**
5. **URL strip:** `https://livevariant.link/s?s=hero&v=a.jpg&v=b.jpg&v=c.jpg`
   in large mono, `v=` params tinted per variant. Caption: "the whole
   test lives in this URL."
6. **Install card, tabbed, prompt-first:** tabs `ask any AI agent`
   (default: a copyable prompt naming the deployment, zero install),
   `skills` (`npx skills add livevariant/livevariant`), `Claude Code /
Cowork`, `Codex`, `any agent (MCP)`. MCP is the fallback tab, never
   the headline. Below the card, a mono "or do it manually" lead-in
   with the Create a test / Deploy your own buttons: the manual path
   follows the agent path, never precedes it.
7. **Footer:** "AGPL open source. Deploy your own on Cloudflare in one
   click."
8. **Dogfooding (site implementation):** the page's own hero
   headline+sub run as a real 2-slot test (3 variants each, ctx dims
   country+device) via the SDK; the scoreboard shows its real numbers.
   An SDK snippet titled "the test running on this page" appears on the
   page (secondary position, hero or near the SDK section).

## Copy Doctrine

- Context-dimension examples are channel-honest: **web/SDK examples use
  `country` and `device`** (real navigations, reliable signals);
  **email examples use `utm_source` and merge-tag values**
  (`c_country={{country}}`), never device, because mail proxies fetch
  images and would be measured instead of readers.
- The classic-flow contrast is mechanically correct: "A 10%, B 10%,
  winner to the 80%, then it ends" vs "everyone in, never ends".
- No refine/restart language anywhere: the test never ends, so there is
  nothing to come back to.
- Slots are always framed as combinations tested together, not
  isolated tests.
- Banned vocabulary: "ship faster", "optimize experiences", "built for
  X" patterns, AI sparkle imagery.

## Decisions Log

| Date       | Decision                                                                  | Rationale                                                                |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 2026-08-04 | Initial system via /design-consultation (research + Codex + indie voice)  | Category converges on platform-SaaS look; we go anti-platform, URL-first |
| 2026-08-04 | Midnight Editorial chosen over cream parlor and Swiss instrument          | User picked round-3 C; parlor ornament read as clutter                   |
| 2026-08-04 | Refine loop removed from the journey                                      | Tests never end; a refine arrow contradicts the core claim               |
| 2026-08-04 | Variant demo = fixed product, changing scenes                             | Truthful to what generation does well; clearer story than 3 lookalikes   |
| 2026-08-04 | Installer is skills-first with tabs; MCP demoted to "any agent"           | `npx -y @livevariant/mcp` runs a server, it installs nothing             |
| 2026-08-04 | Streamgraph semantics: lanes = segments, bands = variants                 | First draft colored lanes as variants; wrong with 3 variants x 2 dims    |
| 2026-08-05 | Accounts are optional ownership, never a gate                             | Claim a stats key from the manage link; local storage stays the default  |
| 2026-08-05 | Unverified redirect destinations get a continue screen, not a block       | Names the destination, kills one-hop phishing, verification removes it   |
| 2026-08-05 | One stats page in the React app; server manage shell deleted              | Two implementations meant every feature built twice or silently once     |
| 2026-08-07 | First band shows the setup conversation beside the email window           | The flow (plan, approve, build) is the product story; the email is proof |
| 2026-08-07 | Conversation and newsletter are separate headed bands, stacked            | Two focal artifacts in one band blurred both; each earns its own header  |
| 2026-08-07 | Install card leads with a paste-into-any-AI prompt; manual buttons follow | Naming the site to any agent is the widest zero-install funnel           |
