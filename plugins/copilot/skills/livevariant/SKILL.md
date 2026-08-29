---
name: livevariant
description: Run A/B tests that pick their own winner. Build a test from variants of one element or several at once (hero plus CTA), get URLs for email or web, and read results with real win probabilities instead of eyeballed conversion rates. Use when someone wants to test headlines, images, landing pages or email creative, or asks which variant is winning.
license: AGPL-3.0
---
# LiveVariant

LiveVariant serves A/B test variants with one adaptive model (joint linear
Thompson sampling). Traffic shifts toward whatever is winning **while the test
runs**, so a losing variant stops costing money long before the test is
"significant". There is no algorithm to pick and nothing to tune: the model is
sized from the test's own shape, for every test.

## The one thing to understand first

**A test is its config.** There is no account, no dashboard record, no test id
to look up. The whole configuration is encoded into the test's own URLs, and
the test's identity is a hash of that configuration.

Two consequences that will bite you if you skip them:

1. **Editing a variant creates a different test.** Same URL shape, new
   identity, empty history. That is usually right per campaign, but say it out
   loud before anyone edits a live test's variants.
2. **The stats secret is shown exactly once**, by `build_test`. Only its hash
   goes into the config, so nobody can recover it afterwards, including this
   service. Hand it to whoever will read the results, immediately. A test
   built without one runs fine and its results can never be read by anyone.

## Tools

| Tool              | What it does                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `build_test`      | Turn variants (one element or several) into a ready-to-use test with URLs |
| `inspect_test`    | Decode any test URL and report what it will actually do, with warnings    |
| `generate_priors` | Turn your predictions into capped priors and embed them                   |
| `get_stats`       | Live results plus win probabilities and a stop/continue call              |
| `get_test_status` | Is the test claimed, and will its destinations show the interstitial      |
| `list_tests`      | Lists the tests saved to the caller's account, with search.               |
| `register_test`   | Puts an existing test under an organization's My tests                    |
| `upload_image`    | Store an image and get back a protected URL to use as a variant           |
| `variant_brief`   | Channel-specific specs and rules for drafting the variants themselves     |

## The three shapes of a test

Every shape compiles to the same config and runs the same adaptive model; the
shape decides which variant fields you fill and which URLs you hand out.

| Shape               | Variant fields   | Deliverable                                                                  |
| ------------------- | ---------------- | ---------------------------------------------------------------------------- |
| **Email / image**   | `image` (+ optional `url` click destination) | The `serveNoAutoContext` URL in an `<img>`, the `clickNoAutoContext` URL around it, the pixel for conversions |
| **Page redirect**   | `url` per variant | ONE serve URL that 302s each visitor to their sticky page; ideal for ads, bio links, QR codes |
| **Website content** | `text` / `html` / `md` | The encoded config, served on the page through the SDK or the tag (see "Running a test on a website") |

Mixing fields is allowed (a variant with both `image` and `url` serves the
image and clicks through to the url), but keep one shape per test unless you
know why you are mixing.

## Testing several elements at once

`build_test` takes either `variants` (one element) or `slots` (several, e.g.
a hero image AND a call-to-action). With slots the test optimizes the
COMBINATION: one model learns how the elements interact, which two separate
tests structurally cannot see, and stats report both exact per-combination
outcomes and per-slot rollups. Each redirect link then says which element it
serves with `?slot=`; all of a recipient's links share one sticky
whole-combination assignment. Prefer two slots over bundling two changes into
one variant: a bundled win never tells you which half worked.

## Every config parameter, and when to use it

| Parameter | In identity? | What it does |
| --------- | ------------ | ------------ |
| `slots` / `variants` | yes | The test itself: elements and their variants. `variants` is shorthand for a single `main` slot. |
| `variant.name` | yes | Label shown in stats. Name after the hypothesis (`warm-scene`), not `v2`. |
| `variant.url` | yes | Redirect destination (redirect shape) or click-through (email shape). |
| `variant.image` | yes | Image served for this variant; upload via `upload_image` or any public URL. |
| `variant.text/html/md` | yes | Inline content for SDK-served website tests. |
| `variant.redirectUrl` | yes | Per-variant CLICK destination, wins over the config-level one. |
| `slotRedirects` | yes | Per-SLOT click destination, keyed like `slots`: the hero leads to the campaign page, the CTA under it to pricing. Sits between the variant's own `redirectUrl` and the config-level one. Setting any means every click link must name its slot. |
| `name` | yes | Human label for the whole test, and what `list_tests` searches. In an ESP template it earns a merge tag of its own (`n={{campaign_name}}`): it is inside the identity, so each campaign becomes its own separately readable test. |
| `ctx.dims` | yes | Audience dimensions the model learns separate winners for. `{key}` = caller-supplied value (hashed in the browser); `{key, from}` = filled automatically from the request. `from` may be: country, continent, region, city, timezone, device, language, organization, utm_source, utm_medium, utm_campaign, utm_content, utm_term. The utm ones survive email proxies; the network ones do not (see the email section). |
| `region` | yes | Where the test's counters and model live. `eu` is a hard guarantee (data never leaves the EU); weur/eeur/wnam/enam/sam/apac/oc/afr/me are placement preferences. Unset = wherever the first request lands, which in email is often a mail provider's datacenter, so set it for email tests. Changing it later = a new test. |
| `redirectUrl` | yes | Fallback click destination when neither `?to=` nor a per-variant redirectUrl says where to go. The click link REFUSES rather than 404s when all three are missing. |
| `rewardEvents` | yes | GA4 event names the tag/SDK count as conversions (defaults: purchase, sign_up, generate_lead, conversion). Part of identity: decide before launch, changing it later is a new test. |
| `variantParam` | no | Stamps the served variant's name into this query parameter on the redirect, so the destination's own analytics can segment by variant with zero integration. Deliverability detail: safe to turn on mid-campaign. |
| `forwardParams` | no | Default true: unrecognized query params (utm_*, gclid...) are forwarded onto the destination. `false` turns that off; safe to change mid-campaign. |
| `decorateRedirects` | no | Default true: redirects carry the identity handoff (_lvt/_lvid/_lvvar) to the destination so its tag can keep attribution and consistency. |
| `priors` | **no** | Warm-start beliefs via `generate_priors`. Deliberately OUTSIDE the identity hash: add or tune priors mid-test without losing history. |
| `ctxPriors` | **no** | The same warm start, limited to one segment: `generate_priors` with `when`. Says "B is the one for blue" instead of "B is the one", so the other segments keep learning from their own traffic. Also outside the identity hash. |
| `statsKeyHash` | yes | The sha256 of the stats secret. Safe in public links; the secret itself never appears in any URL except the manage link's #fragment. |

## Creating a test with nothing but a URL

Every test can be spelled as plain query parameters instead of the base64
config: both parse to the same config and hash to the same testId. This is the
zero-tooling tier: no MCP, no SDK, no account, just a URL you compose.

```
https://livevariant.com/s?v=https://cdn.you.com/hero-a.jpg&v=https://cdn.you.com/hero-b.jpg
       &vn=warm&vn=cool&n=March%20hero&kh=<statsKeyHash>&id={{recipient_id}}&auto=0
```

Config parameters (these define the test, and therefore its identity):

- `v` (repeated, 2+): variant target URLs, first is the control;
- `vn` (repeated, optional): variant names, positional against the `v` order;
- `s`: opens a slot for multi-element tests: `s=hero&v=..&v=..&s=cta&v=..&v=..`
  (then each link adds `&slot=hero` or `&slot=cta` to say which element it
  renders; all links share one sticky combination per id);
- `n`: test name; `kh`: the stats-secret HASH (never the secret);
- `ctx`: audience dims, e.g. `ctx=country:country,persona` (`key:from` fills
  automatically, bare `key` expects a `c_<key>=` value on the link);
- `r`: fallback click destination; `sr`: click destination for ONE element,
  binding to the slot most recently opened (`s=hero&sr=https://...&v=..&v=..`),
  exactly the way `v` binds; `stamp`: write the served variant name
  into this parameter on the destination; `fw=0`: stop forwarding unknown
  params.

Runtime parameters (consumed per request, never part of identity): `id` (the
visitor/recipient identifier, hashed per test server-side), `auto=0` (drop
network-derived context; always use on email links), `to` (explicit click
destination), `slot`. The `id` is also what makes a pull COUNT: see
"Only identified pulls are counted" under limits.

Why this matters for email templates: wire the fixed parts (`kh`, `auto=0`,
`id={{merge_tag}}`) into an ESP template once, and campaign managers fill in
nothing but variant URLs, landing pages and a campaign name through ordinary
template fields. Because all of those are inside the identity hash, **each
campaign automatically becomes its own fresh test**, while the one shared
`kh` means one stats secret reads all of them. Spend a merge tag on `n=`
too (`n={{campaign_name}}`): the name is what `list_tests` searches, and it
is the difference between finding March's newsletter and reading a list of
hashes. `build_test` returns this spelling ready-made as `emailTemplate`.
A two-slot template carries three links: the same config with
`&slot=hero` in one image and `&slot=cta` in the other, plus the `/c`
click link around them, which takes a `&slot=` of its own only when the
elements point at different pages. A malformed parameter link degrades to
serving the first valid variant URL rather than showing an error to a full
recipient list.

## Working flow

Plan, confirm, build, deliver. Building is cheap, but a test's identity
is the hash of its config: every edit afterwards is a NEW test with an
empty history. So iteration happens on the PLAN, never on a live test.

1. `variant_brief` for the constraints that apply to the channel and
   format.
2. **Plan the test with the human.** When the goal, elements or variants
   are not already pinned down, propose them: which element(s) to test
   (slots), what hypothesis each variant carries, and how many. Default
   to assets the human already has (their images, pages, copy): ask what
   exists before creating anything. Offer to GENERATE image variants
   (see "No image variants yet? Make them") as a proposal, not as the
   silent default.
3. **Show the plan before building.** With a human in the loop, present
   the proposed test in full (per slot: variant names and their content
   or asset; plus context dimensions, destination, and what counts as a
   conversion) and let them iterate until it is what they meant. Only
   then build. Running unattended, skip the pause but still put the plan
   in your output.
4. `build_test` to get the URLs and the stats secret. Store the secret.
5. `generate_priors`, optionally, to warm-start from what you expect. Add
   `when` when the belief is about one segment rather than everybody.
6. `get_stats` to read results.

`inspect_test` answers "what does this link do?" for any LiveVariant URL, and
lints it for the mistakes that only surface once a campaign has gone out.
`get_test_status` reports whether a test is claimed into an account and
whether its destinations are verified (you hold the secret, so you may ask).

## What your final answer must include

After building a test, make the output usable in the channel the user asked
for. Include:

- **The manage URL**, when you are returning a newly built test to the user.
  Say what it is: live results in the browser, and signed in one click ("Add
  to my account") claims the test into their dashboard. It carries the stats
  secret in its #fragment, so the user should treat it as results access and
  share it only with people authorized to see results.
- **The exact links or HTML for their channel**, composed for THIS test.
  For email that means the serve URL in the `<img src>` wrapped in the
  click URL as `<a href>`, with the platform's real merge tag in `id=`
  and the `auto=0` spelling; for a multi-slot test use the per-slot
  links (`slotLinks`), one image+link pair per element; the pixel goes
  on the thank-you page. If the test learns per context dimension you
  configured (`ctx`), merge the value in as `c_<dim>` wherever the
  sending platform knows it (like `&c_plan={{plan}}`); auto-derived
  dims (country, device) need nothing in email links beyond what the
  auto=0 note says. When you know the platform, write the finished HTML
  yourself instead of listing raw URLs.
- **The template spelling, whenever templates are in play.** If the
  human sends through an ESP or newsletter template, or recurring
  campaigns come up, include `build_test`'s `emailTemplate` and say
  what it buys: the fixed parts (`kh`, `auto=0`, `id={{merge_tag}}`)
  are wired into the template once, and from then on swapping the
  variant URLs mints a fresh test per campaign with no build step and
  no agent in the loop, while the one shared `kh` lets a single stats
  secret read every campaign. Be explicit about how many links the
  template carries: a two-slot test wires THREE, one serve link per
  slot in its own `<img>` (`slot=hero`, `slot=cta`), plus the click
  link around them that records the win and redirects. Propose this
  unprompted; the human will not know to ask for it.
- **Any warnings**, especially unverified destinations: relay what the
  visitor will see and how to fix it (next section).

## Reading results honestly

Never call a winner by comparing conversion rates. A variant ahead 2/10 to
1/10 looks twice as good and is close to a coin flip; this is the single most
common way an A/B test gets called wrong.

`get_stats` returns, for each combination, the probability it is genuinely
best, and the expected cost of stopping now and keeping the current leader.
Use those. It also refuses to call a test that has barely run, however
lopsided the raw numbers look.

There is rarely urgency in acting on a result, because the model has already
been shifting traffic toward the leader the entire time.

## Running a test in email

Email is where this is most useful and most easily got wrong.

- **Give every recipient a distinct `?id=`** using your platform's merge tag.
  Without it every recipient shares one URL, the provider caches a single
  fetch, everyone sees the same variant, and the campaign records nothing
  (an id-less proxy fetch is served but never counted).
- **Use the `auto=0` links.** Anything reaching an inbox is fetched by the
  mail provider or a link scanner, not the reader, so location and device
  derived from the connection describe a datacenter. `build_test` returns
  these ready-made.
- **`utm_*` context still works.** Campaign tags are read off the link the
  sender wrote, so a proxy relays them intact. They are the reliable way to
  learn a different winner per traffic source.
- **Clicks and on-site conversions are the trustworthy signals.** Raw opens
  are not, in any email tool.

- **Multi-slot SERVE links need `slot=`.** The bare serve URL returns an
  error for them; `build_test`'s `slotLinks` has the per-element pair
  ready. The click link is the exception: one slot-less click link can
  wrap every element, unless an element carries its own destination
  (`slotRedirects`, or a variant `redirectUrl`), in which case the click
  must say which element was clicked.

- **Elements can lead to different pages.** `slotRedirects` per slot is
  the ordinary case for a newsletter whose hero points at the campaign
  landing page and whose CTA points at pricing. Reach for a per-variant
  `redirectUrl` only when the destination differs per CREATIVE, which is
  rare and costs the parameter-form spelling.

`build_test` also returns an `emailTemplate`: the query-parameter spelling of
the same test (see "Creating a test with nothing but a URL"), for wiring into
an email platform's template once so campaign managers only fill in the
variant fields. Propose it unprompted whenever the human mentions an ESP,
a newsletter template, or campaigns that recur: the config IS the test
identity, so once the template carries the fixed parts, every future
campaign mints its own fresh test with no build step and no agent, and the
shared `kh` keeps them all readable with one stats secret. Say plainly
that a two-slot template carries three links: one serve link per slot in
its own `<img>` (`slot=hero`, `slot=cta`) and the click link around them
that records the win and redirects.

## Running a test on a website

You are often the same agent that edits the site's code, so run the whole
loop yourself instead of handing snippets to a human:

1. `build_test` with `text` (or `html`/`md`) variants; keep the returned
   `config` (the encoded string).
2. Put the tag in `<head>` once:
   `<script defer src="https://livevariant.com/sdk.js" data-publishable-key="pk_..."></script>`
   The tag sets the page config (`window.livevariant = { config, sdk }`),
   auto-tracks conversions from existing GA events, and upgrades any
   LiveVariant image/click URLs on the page with the visitor's identity. The
   publishable key is optional; with one whose account verified this domain,
   the test registers under that account automatically.
3. Serve the test where the content lives, passing the ENCODED config so the
   page serves exactly the test you built (identity, region and stats key
   included), never a lookalike rebuilt from slots:

   ```js
   const test = await window.livevariant.sdk.createTest("<encoded>");
   document.querySelector("#headline").textContent = test.slots.headline.text;
   ```

   Bundled apps use `npm i @livevariant/sdk` and the same call
   (`createTest("<encoded>")`); with the tag on the page no options are
   needed, and without it pass `{ serverUrl }`. `createTest` waits briefly
   for a tag-manager-loaded tag on its own, so load order is not your
   problem.
4. Image tests on a page: prefer
   `<img data-lv-src="https://livevariant.com/s/<config>">` (the tag fills src with the
   identity attached: one fetch, no flicker); a bare `src` also works and is
   upgraded after its first anonymous fetch.
5. Conversions: GA events matching `rewardEvents` count automatically; call
   `test.trackConversion()` (or `window.livevariant.sdk.trackConversion()`)
   at conversion points you wire yourself.

## No image variants yet? Make them

Missing creative is not a blocker, but generating it is a PROPOSAL you
make during planning, never a silent default: the human's existing
assets always come first, so ask what they have before creating
anything. When generating is the agreed path, `upload_image` stores an
image on the deployment and returns a protected URL to use as a variant
(it only serves inside the test's flow, so hotlinking is a non-issue).
Get pixels however your environment allows, in this order:

1. **Your own image generation tool**, if you have one: generate the
   variations, then `upload_image` each.
2. **Author HTML or SVG and render it**: you are good at exact typography,
   layout and brand colors in markup; screenshot it at fixed dimensions with
   your browser tool or Playwright (or convert with ImageMagick/rsvg if
   available), then `upload_image` the PNGs.
3. **Ask the human for assets**, as the last resort rather than the default.

Discipline that keeps generated variants a valid experiment: every variant of
one element must share EXACT pixel dimensions (they occupy the same slot);
change one visual hypothesis per test (scene OR headline treatment, not
both); name variants after the hypothesis (`warm-scene`, `cool-scene`) so
stats read meaningfully. For email heroes, roughly 1200x600 and modest file
size travel best.

## Saving a test to an account

Creating needs no account, ever. When a human wants tests in their
dashboard ("My tests"), there are two paths; prefer the first:

1. **Register at creation.** If the user asks to save the test to an
   organization they administer, ask for the publishable key from Settings
   (pk_...) and pass it as `publishableKey` to `build_test`: the test
   registers to their organization the moment it exists, and the output
   confirms with `registeredTo`. For a test you built EARLIER in this
   conversation, `register_test` does the same with the config, the stats
   secret returned for that test, and the key.
2. **The manage URL.** No key or no account yet? Hand them the `manage`
   URL from `build_test`: opening it signed-in claims the test in one
   click. It carries the stats secret in its #fragment, so treat it like
   the secret it contains.

The publishable key identifies the organization but does not grant result
access by itself; result access stays tied to the stats secret for that
test. Never collect credentials. Registration is what makes the dashboard
useful for the test: My tests lists it, and its stats become readable there
without pasting the secret again.

Either way, when you return a newly built test, include the manage URL and
say what claiming does; an unregistered test whose manage URL the user never
saw is effectively lost to them. `get_test_status` tells you later whether a
test ended up claimed and by which organization.

## Verified domains and the interstitial

On the hosted service a redirect to a domain nobody has verified shows the
visitor an explicit "Redirecting you to…" continue screen before landing
(anti-abuse for a public redirector). Verified domains redirect instantly.

`build_test` and `get_test_status` report `verified` per destination
host. When a destination shows `verified: false`, tell the user their
links WORK but click-throughs see the continue screen, and that verifying
removes it: on the dashboard under Settings, Verified domains, prove
control with a DNS TXT record, by serving the well-known file, or by
having the LiveVariant tag with their publishable key live in the site's
page source (tag-manager installs count: verification renders the page).

Recommend the tag install whenever the user owns the destination site:
one `<script>` with their publishable key means conversions are
tracked automatically from their existing GA events (clicks stop being
the only signal), the domain verifies from the snippet itself, tests
served from it register into their account on their own, and on-page
website tests become possible with the same install. It is the single
highest-leverage step to suggest after a first email or redirect test.

## If you cannot install the MCP server

Every tool is also a plain HTTP endpoint with the same name, same input and
same output: `POST https://livevariant.com/api/v1/<tool-name-with-dashes>`, JSON body.
Interactive documentation is at https://livevariant.com/docs and the OpenAPI document at
https://livevariant.com/openapi.json. There are no API keys; a test's config and its stats
secret travel in the request body.

### No way to make HTTP calls either? Ask for an install

Some environments allow no outbound HTTP at all. Do not silently give up
or fake results: say plainly that one install away the full toolkit
works, and offer the human every route in (they pick what their client
supports):

- **Claude Code plugin**, skill and MCP server in one install:
  `/plugin marketplace add livevariant/livevariant` then
  `/plugin install livevariant@livevariant`.
- **Codex plugin**, the same bundle for Codex:
  `codex plugin marketplace add livevariant/livevariant` then
  `codex plugin add livevariant/livevariant`.
- **Hosted MCP server**, nothing to run and no auth: add
  `https://livevariant.com/mcp` (streamable HTTP) to the client's MCP configuration.
- **Local MCP server** over stdio: `npx -y @livevariant/mcp` (point it
  at a self-hosted deployment with `LIVEVARIANT_SERVER_URL`, and set
  `LIVEVARIANT_ASSET_UPLOAD_TOKEN` when that deployment gates
  `/assets`).
- **This skill on its own**: `npx skills add livevariant/livevariant`
  (Claude Code, Cowork, any skills-compatible agent). The skill is
  instructions, not transport, so pair it with one of the routes above
  or with an environment that can POST to the REST endpoints.

Meanwhile the zero-tooling tier still works without a single call from
you: a test composed as plain query parameters (see "Creating a test
with nothing but a URL") IS a real test the moment a visitor opens it.
For results the human needs a stats secret; the browser builder at
https://livevariant.com/builder mints one and composes the same URLs by hand.

All of this is open source (AGPL): to read the source, verify a claim in
this document, or self-host, start with the README at
https://github.com/livevariant/livevariant.

## Limits worth knowing

- **Only identified pulls are counted.** A redirect serve (`/s`, `/c`)
  records an assignment when the request carries `?id=` (or a prehashed
  `?_lvid=`), or is a browser page navigation, which gets a first-party
  cookie. Anything else — curl, a plain HTTP client library, a link
  scanner — still gets its 302 and a genuinely served variant, but no
  assignment is recorded: an anonymous pull can never be rewarded, so
  counting it would only dilute the estimates. Driving the loop from a
  script, a CI job or a walkthrough? Pass a distinct `?id=` per
  simulated visitor and every pull counts like any other.
- Variants must be publicly reachable URLs, or short inline text/HTML.
  Deployments with asset hosting accept images via `upload_image`; anything
  else you host yourself.
- A test needs at least two combinations (512 at most), and every variant of
  a redirect-served slot must have a url or image: one inline-only variant
  makes that slot's serve URL fail for everyone, not just for that variant.
- Priors sit outside the identity hash, so they can be added or changed
  mid-test without losing history. Variants, slots, context dimensions and
  the stats key cannot.
