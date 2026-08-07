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
| `name` | yes | Human label for the whole test. |
| `ctx.dims` | yes | Audience dimensions the model learns separate winners for. `{key}` = caller-supplied value (hashed in the browser); `{key, from}` = filled automatically from the request. `from` may be: country, continent, region, city, timezone, device, language, organization, utm_source, utm_medium, utm_campaign, utm_content, utm_term. The utm ones survive email proxies; the network ones do not (see the email section). |
| `region` | yes | Where the test's counters and model live. `eu` is a hard guarantee (data never leaves the EU); weur/eeur/wnam/enam/sam/apac/oc/afr/me are placement preferences. Unset = wherever the first request lands, which in email is often a mail provider's datacenter, so set it for email tests. Changing it later = a new test. |
| `redirectUrl` | yes | Fallback click destination when neither `?to=` nor a per-variant redirectUrl says where to go. The click link REFUSES rather than 404s when all three are missing. |
| `rewardEvents` | yes | GA4 event names the tag/SDK count as conversions (defaults: purchase, sign_up, generate_lead, conversion). Part of identity: decide before launch, changing it later is a new test. |
| `variantParam` | no | Stamps the served variant's name into this query parameter on the redirect, so the destination's own analytics can segment by variant with zero integration. Deliverability detail: safe to turn on mid-campaign. |
| `forwardParams` | no | Default true: unrecognized query params (utm_*, gclid...) are forwarded onto the destination. `false` turns that off; safe to change mid-campaign. |
| `decorateRedirects` | no | Default true: redirects carry the identity handoff (_lvt/_lvid/_lvvar) to the destination so its tag can keep attribution and consistency. |
| `priors` | **no** | Warm-start beliefs via `generate_priors`. Deliberately OUTSIDE the identity hash: add or tune priors mid-test without losing history. |
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
- `r`: fallback click destination; `stamp`: write the served variant name
  into this parameter on the destination; `fw=0`: stop forwarding unknown
  params.

Runtime parameters (consumed per request, never part of identity): `id` (the
visitor/recipient identifier, hashed per test server-side), `auto=0` (drop
network-derived context; always use on email links), `to` (explicit click
destination), `slot`.

Why this matters for email templates: wire the fixed parts (`kh`, `auto=0`,
`id={{merge_tag}}`) into an ESP template once, and campaign managers fill in
nothing but variant URLs through ordinary template fields. Because variant
URLs are inside the identity hash, **each campaign automatically becomes its
own fresh test**, while the one shared `kh` means one stats secret reads all
of them. `build_test` returns this spelling ready-made as `emailTemplate`.
A malformed parameter link degrades to serving the first valid variant URL
rather than showing an error to a full recipient list.

## Working flow

1. `variant_brief` for the constraints that apply to the channel and format.
2. Draft the variants yourself against that brief.
3. `build_test` to get the URLs and the stats secret. Store the secret.
4. `generate_priors`, optionally, to warm-start from what you expect.
5. `get_stats` to read results.

`inspect_test` answers "what does this link do?" for any LiveVariant URL, and
lints it for the mistakes that only surface once a campaign has gone out.

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
  fetch, everyone sees the same variant, and the campaign records one
  assignment.
- **Use the `auto=0` links.** Anything reaching an inbox is fetched by the
  mail provider or a link scanner, not the reader, so location and device
  derived from the connection describe a datacenter. `build_test` returns
  these ready-made.
- **`utm_*` context still works.** Campaign tags are read off the link the
  sender wrote, so a proxy relays them intact. They are the reliable way to
  learn a different winner per traffic source.
- **Clicks and on-site conversions are the trustworthy signals.** Raw opens
  are not, in any email tool.

`build_test` also returns an `emailTemplate`: the query-parameter spelling of
the same test (see "Creating a test with nothing but a URL"), for wiring into
an email platform's template once so campaign managers only fill in the
variant fields.

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
   publishable key is optional and PUBLIC; with one whose account verified
   this domain, the test registers under that account automatically.
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

Missing creative is not a blocker: `upload_image` stores an image on the
deployment and returns a protected URL to use as a variant (it only serves
inside the test's flow, so hotlinking is a non-issue). Get pixels however
your environment allows, in this order:

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

1. **Register at creation.** Ask once: "paste your publishable key from
   Settings (pk_..., it is public and safe here)". Then pass it as
   `publishableKey` to `build_test`: the test registers to their
   organization the moment it exists, and the output confirms with
   `registeredTo`. For a test you built EARLIER in this conversation,
   `register_test` does the same with the config, the stats secret you
   still hold, and the key.
2. **The manage URL.** No key or no account yet? Hand them the `manage`
   URL from `build_test`: opening it signed-in claims the test in one
   click. It carries the stats secret in its #fragment, so treat it like
   the secret it contains.

Why this is safe to do in chat: the publishable key only NAMES the org
and grants nothing alone; authority is always the stats secret, which
`build_test` mints itself and you never ask the user for. Never collect
credentials. Registration is what makes the dashboard useful for the
test: My tests lists it, and its stats become readable there without the
secret.

## If you cannot install the MCP server

Every tool is also a plain HTTP endpoint with the same name, same input and
same output: `POST https://livevariant.com/api/v1/<tool-name-with-dashes>`, JSON body.
Interactive documentation is at https://livevariant.com/docs and the OpenAPI document at
https://livevariant.com/openapi.json. There are no API keys; a test's config and its stats
secret travel in the request body.

## Limits worth knowing

- Variants must be publicly reachable URLs, or short inline text/HTML.
  Deployments with asset hosting accept images via `upload_image`; anything
  else you host yourself.
- A test needs at least two combinations (512 at most), and every variant of
  a redirect-served slot must have a url or image: one inline-only variant
  makes that slot's serve URL fail for everyone, not just for that variant.
- Priors sit outside the identity hash, so they can be added or changed
  mid-test without losing history. Variants, slots, context dimensions and
  the stats key cannot.
