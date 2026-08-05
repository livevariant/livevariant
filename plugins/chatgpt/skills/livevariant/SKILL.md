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
| `list_tests`      | Lists the tests saved to the caller's account, with search.               |
| `upload_image`    | Store an image and get back a protected URL to use as a variant           |
| `variant_brief`   | Channel-specific specs and rules for drafting the variants themselves     |

## Testing several elements at once

`build_test` takes either `variants` (one element) or `slots` (several, e.g.
a hero image AND a call-to-action). With slots the test optimizes the
COMBINATION: one model learns how the elements interact, which two separate
tests structurally cannot see, and stats report both exact per-combination
outcomes and per-slot rollups. Each redirect link then says which element it
serves with `?slot=`; all of a recipient's links share one sticky
whole-combination assignment. Prefer two slots over bundling two changes into
one variant: a bundled win never tells you which half worked.

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
the same test, for wiring into an email platform's template once so campaign
managers only fill in the variant fields.

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
