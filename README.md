# LiveVariant

**The test that keeps testing.**

Open-source A/B testing that never stops. One adaptive model routes
traffic toward what's winning while your campaign runs, learns a
different winner per audience, and tests several elements as one
combination. The whole test lives in a URL: no account, no platform,
nothing to install on your site.

Built for LLM agents first: your assistant drafts the variants, uploads
them, builds the test, and hands you one URL to paste in your
newsletter.

## Install the toolkit

Skills (recommended, works with Claude Code and Cowork):

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

Any other agent, via MCP: hosted at `https://livevariant.com/mcp`, or
stdio with `npx -y @livevariant/mcp`. No API keys: a test's config and
its stats secret carry all the authority there is.

Then just ask your assistant:

> "A/B test these two hero images in tomorrow's newsletter."

It uploads the images, builds the test, and returns one URL. Ask it for
`get_stats` later and it tells you the win probability per combination,
not just raw rates.

## Test a hero image by swapping one URL

Replace your email's image URL with ours and reference your variants.
That's the whole integration:

```
https://livevariant.link/s?v=https://cdn.you.com/hero-a.jpg
                          &v=https://cdn.you.com/hero-b.jpg
                          &id={{recipient_id}}
```

Every recipient sticks to their variant across opens, traffic shifts
toward the winner while the campaign runs, and clicks (`/c`) plus a
thank-you-page pixel (`/px`) close the loop. Add `&kh=<hash>` from the
builder to make results readable with your stats secret.

Multiple elements? Slots test the **combination**, not isolated pieces:

```
https://livevariant.link/s?s=hero&v=hero-a.jpg&v=hero-b.jpg
                          &s=product&v=shot-1.jpg&v=shot-2.jpg
                          &id={{recipient_id}}&slot=hero
```

One link per element (`&slot=`), one sticky combination per recipient,
and the model learns that hero A only wins _with_ product shot 2, which
two separate tests can never see.

For audience segments in email, use what survives mail proxies: campaign
tags (`ctx=source:utm_source`) or your ESP's merge fields
(`&c_country={{country}}`).

## Test copy inline with the SDK

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
and the test is scoped to your domain automatically. If our server is
unreachable, visitors get your control and nothing breaks.

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

## Private by minimization

The server stores hashed visitor ids, opaque context keys, numeric
model state, and coarse signals for stats. Raw ids and raw context
never; variant content never, except images you explicitly host with
us. EU customers can pin a test's entire state inside the EU
(`region: "eu"`). AGPL, so every claim is checkable.

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant)

One click clones this repo into your account and deploys the whole
thing: serving, dashboard, tools API, MCP endpoint. Nothing to
configure; every URL is built from the origin the request arrived on.
We encourage it: the hosted service and your deployment run the same
AGPL code.

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
