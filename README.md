<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="design-assets/generated/logo-dark.svg"
  />
  <img
    alt="LiveVariant"
    src="design-assets/generated/logo-light.svg"
    height="72"
  />
</picture>

# LiveVariant

**The test that keeps testing.**

Open-source A/B testing that never stops. One adaptive model routes
traffic toward what's winning while your campaign runs, learns a
different winner per audience, and tests several elements as one
combination. The whole test lives in a URL: no account, no platform,
nothing to install on your site.

[livevariant.com](https://livevariant.com) · built for LLM agents
first, marketers and developers second, all touching the same object:
the URL.

## See it live

The headline on [livevariant.com](https://livevariant.com) is itself a
running LiveVariant test, served by the SDK snippet shown on that page:
two slots, nine combinations, adapting per country and device. We test
our own homepage with our own product.

## Let your LLM run it

The whole setup is one conversation, and there is nothing to install:
naming the site in any AI chat is enough for the agent to discover the
tools and take it from there.

> "I want to A/B test my next 'Daily brew' newsletter with
> livevariant.com. Give me some ideas and set it up."

Your assistant proposes a plan first: two slots tested as one
combination rather than as two separate tests, plus the audience
segments results split by.

```
slot hero: packshot / cafe / fireside    (three drafted scenes, one product)
slot cta:  "Shop the roast" / "Start your ritual" / "Brew better today"
ctx:       utm_source · country (merge tag)
```

> "Looks good!"

It builds the test and hands back three links for the template (one
image link per slot, plus the click link that records the win and
redirects) and your manage link with live results:

```
img hero  livevariant.link/s/<config>?slot=hero&id={{email_or_any_id}}&auto=0
img cta   livevariant.link/s/<config>?slot=cta&id={{email_or_any_id}}&auto=0
click     livevariant.link/c/<config>?id={{email_or_any_id}}
manage    livevariant.com/manage/<config>#<stats-secret>
```

Nine combinations, every recipient sticks to their own, traffic shifts
toward whatever combination is winning while the campaign runs, and a
different combination can win per audience. Ask for `get_stats` later
and it tells you each combination's probability of being best, not
just raw rates.

### Give your agent the toolkit

Installing buys deeper integration: the full skill in context, tools
without discovery. Skills (recommended, works with Claude Code and
Cowork):

```bash
npx skills add livevariant/livevariant
```

Claude Code plugin (this repository is the marketplace):

```bash
claude
/plugin marketplace add livevariant/livevariant
/plugin install livevariant@livevariant
```

Codex plugin:

```bash
codex plugin marketplace add livevariant/livevariant
codex plugin add livevariant/livevariant
```

Any other agent: MCP hosted at `https://livevariant.com/mcp`, stdio via
`npx -y @livevariant/mcp`, or plain HTTP at `POST /api/v1/<tool>`
(interactive docs at `/docs`, spec at `/openapi.json`). No API keys: a
test's config and its stats secret carry all the authority there is.

## Or do it yourself

The [builder](https://livevariant.com/builder) composes a test in the
browser, no code and no account. Or write the URL by hand:

```
https://livevariant.link/s?v=https://cdn.you.com/hero-a.jpg&v=https://cdn.you.com/hero-b.jpg&id={{recipient_id}}
```

Replace your email's image URL with that, and the integration is done.
Every recipient sticks to their variant across opens, traffic shifts
toward the winner while the campaign runs, and clicks (`/c`) plus a
thank-you-page pixel (`/px`) close the loop. Add `&kh=<hash>` from the
builder to make results readable with your stats secret.

Multiple elements? Slots test the **combination**, not isolated pieces
(wrapped here for reading; variant values are full URLs):

```
https://livevariant.link/s?s=hero&v=https://cdn.you.com/hero-a.jpg
                          &v=https://cdn.you.com/hero-b.jpg
                          &s=product&v=https://cdn.you.com/shot-1.jpg
                          &v=https://cdn.you.com/shot-2.jpg
                          &id={{recipient_id}}&slot=hero
```

One link per element (`&slot=`), one sticky combination per recipient,
and the model learns that hero A only wins _with_ product shot 2, which
two separate tests can never see.

For audience segments in email, use what survives mail proxies: campaign
tags (`ctx=source:utm_source`) or your ESP's merge fields
(`&c_country={{country}}`).

### Test your website, too

Landing pages are tests as well: images and content served directly on
the page. Developers and LLM coding agents wire one up by installing
the SDK; the config is readable on purpose, and this is the whole test:

```bash
npm i @livevariant/sdk
```

```js
import { createTest } from "@livevariant/sdk";

const test = await createTest(
  {
    slots: {
      headline: [
        "The daily cup, perfected",
        "Mornings, upgraded",
        "Coffee worth waking for"
      ],
      cta: ["Shop the roast", "Start your ritual", "See the blends"]
    },
    ctx: {
      dims: [
        { key: "country", from: "country" },
        { key: "device", from: "device" }
      ]
    }
  },
  { serverUrl: "https://livevariant.link" }
);

headline.textContent = test.slots.headline.text;
cta.textContent = test.slots.cta.text;
// conversions auto-tracked from your existing GA events
```

Two slots, nine combinations, a different winner per country and device,
and the test is scoped to your domain automatically. If the server is
unreachable, visitors get your control and nothing breaks. The headline
on [livevariant.com](https://livevariant.com) runs exactly this way; the
page shows its own snippet.

## Read your results

Building a test (through the builder or `build_test`) shows the stats
secret exactly **once**; only its hash travels in the config, so nobody
can recover it later, including us. Keep it.

- The **manage URL** carries the secret in its `#fragment` (which never
  reaches server logs): open it for live per-combination and per-slot
  numbers.
- Agents call **`get_stats`** with the same secret and get win
  probabilities plus an honest stop/continue call, instead of eyeballed
  conversion rates.
- A test built without a stats key still serves and learns, but its
  results are unreadable forever: no secret can match a hash that is
  not there.

## Own your tests (optional)

No account is ever required, but on [livevariant.com](https://livevariant.com)
you can create one (email link or Google) and it buys three things:

- **Claiming.** Open any manage link while signed in and click "Add to
  my account": the stats key behind it is claimed to you, nobody else
  can claim it, and every test built from it, past and future, appears
  under My tests on any browser. Your stats secret keeps working; a
  per-key lock can additionally require sign-in if it ever leaks.
- **Verified domains.** Prove a domain with a DNS TXT record or a
  well-known file and redirects to it skip the "Redirecting you to…"
  confirmation screen that unverified destinations show to visitors.
- **SDK auto-registration.** Create a publishable `pk_` key, pass it to
  the SDK from a verified domain, and inline tests register themselves
  under My tests, readable without any secret in the loop.

## Why not a normal A/B test?

The classic email flow sends A to 10%, B to 10%, waits a few hours, and
blasts the "winner" to the rest. Decided once, on early openers, one
element at a time, one answer for everyone, and it ends.

LiveVariant keeps everyone in the test forever: allocation adapts on
every serve, per segment, across combinations, and priors (yours or
your LLM's) give it a head start that real data can always override.
Keep your ESP's subject-line test (subjects render before anything
loads); everything after the open is ours. The mechanics are the
published literature (Thompson 1933; Chapelle & Li 2011; Li et al.
2010; Hill et al., KDD 2017; Shivaswamy & Joachims 2012), implemented
small enough to audit.

## Deploy your own

This product is designed to be self-deployed. Our server can be used
for testing, but its state can be destroyed at any time; a managed
hosted version is in the works. Your deployment runs the same AGPL code
with none of those caveats:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant)

One click clones this repo into your account and deploys the whole
thing: serving, dashboard, tools API, MCP endpoint. Nothing to
configure; every URL is built from the origin the request arrived on.
The self-host build contains no auth framework at all (a test asserts
it), and three optional env vars cover the trust knobs: comma-separated
`LV_ALLOWED_ORIGINS` locks the SDK endpoints to your own sites,
`LV_ALLOWED_DESTINATIONS` + `LV_UNLISTED_DESTINATIONS` decide whether
redirect destinations off your list are allowed, blocked, or shown
behind a continue screen, and `LV_API_TOKEN` gates the tools API and
MCP endpoint behind a bearer token for server-to-server calls. Custom
logic instead of env vars? Implement the two-method `TrustPolicy` (and
optionally `AccountsProvider`) ports from `@livevariant/server` and
pass them to `createApp`.

```bash
npm ci && npm run build && npm run deploy
```

## Development

Node 24 (`nvm use`). `npm ci`, `npm run build`, `npm test`
(`test:no-browser` for the Playwright-free subset). The deep technical
reference lives in [CLAUDE.md](CLAUDE.md), which is also what your
coding agent reads; the design system in [DESIGN.md](DESIGN.md).

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Your
first pull request asks you to sign the
[Contributor License Agreement](.github/CLA.md).

## License

[AGPL-3.0](LICENSE). Self-hosting for your own use is unrestricted; if
you modify LiveVariant and offer it as a network service, publish your
modifications.
