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

Install the toolkit. Skills (recommended, works with Claude Code and
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

Then just ask your assistant:

> "A/B test these two hero images in tomorrow's newsletter."

It uploads the images, builds the test, and returns one URL. Ask it for
`get_stats` later and it tells you the win probability per combination,
not just raw rates.

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

### Test copy inline with the SDK

The config is readable on purpose; this is the whole test:

```js
import { createTest } from "@livevariant/sdk";

const test = await createTest(
  {
    slots: {
      headline: ["Ship faster", "Ship safer", "Ship happier"],
      cta: ["Buy now", "Try free", "See pricing"]
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
unreachable, visitors get your control and nothing breaks.

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

```bash
npm ci && npm run build && npm run deploy
```

## Development

Node 24 (`nvm use`). `npm ci`, `npm run build`, `npm test`
(`test:no-browser` for the Playwright-free subset). The deep technical
reference lives in [CLAUDE.md](CLAUDE.md), which is also what your
coding agent reads; the design system in [DESIGN.md](DESIGN.md).

## License

[AGPL-3.0](LICENSE). Self-hosting for your own use is unrestricted; if
you modify LiveVariant and offer it as a network service, publish your
modifications.
