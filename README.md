# LiveVariant

A/B testing without the platform: your variants compete live.

LiveVariant serves test variants with multi-armed bandits (Thompson
sampling), so traffic shifts toward the winner while the test runs instead
of waiting for a frozen 50/50 split to reach significance. The entire test
configuration travels base64url-encoded in the URL: no accounts, no test
registration, no dashboard required.

## How it works

- **The config is the test.** Arms, formats, and context dimensions are
  encoded into the serve URL; the test's identity is a hash of that config.
  Tampering with a URL just derives a different test with empty state.
- **Privacy by minimization.** The server stores opaque hashed ids and
  numeric bandit state; variant content, raw user ids, and raw context
  values are never persisted.
- **Contextual serving.** Plain, bucketed, and linear Thompson sampling:
  the right variant per country, device, or persona, learned online.
- **LLM warm-start priors.** An MCP server lets your own LLM draft
  variants, estimate per-context win probabilities, and embed them as
  capped priors, so tests start smart and let real data take over.

## Packages

| Package                | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `@livevariant/core`    | Config codec, hash identity, bandit math, priors, state        |
| `@livevariant/server`  | Hono serving app behind a pluggable StateStore + TestBackend   |
| `@livevariant/workers` | Cloudflare deployment: one SQLite Durable Object per test      |
| `@livevariant/sdk`     | Browser SDK: sticky variants, GA-driven conversion tracking    |
| `apps/web`             | livevariant.com: product site and account-free test builder    |
| `@livevariant/tools`   | One registry of every agent operation: MCP, REST and the SKILL |
| `@livevariant/mcp`     | MCP server (stdio) over that registry                          |

### HTTP surface

| Endpoint               | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `GET /s/:cfg`          | Serve: assigns a variant, 302s to it (email/link mode)      |
| `GET /c/:cfg`          | Click: rewards, then redirects onward                       |
| `GET /s`, `GET /c`     | The same two, with the config in plain query parameters     |
| `GET /px/:cfg`         | 1x1 gif conversion pixel (no-JS thank-you pages)            |
| `POST /choose`         | JS mode: content-free assignment, returns an arm index      |
| `POST /reward`         | JS mode: `{testId, idHash, amount}`                         |
| `GET /stats/:cfg`      | Creator-only stats (Bearer stats secret)                    |
| `POST /recompute/:cfg` | Creator-only: rebuild derived state from the event log      |
| `POST /exclude/:cfg`   | Creator-only: quarantine traffic sources or time windows    |
| `GET /manage/:cfg`     | Creator dashboard shell (secret travels in the `#fragment`) |
| `POST /api/v1/*`       | The agent tools over plain HTTP (one endpoint per tool)     |
| `ALL /mcp`             | The same tools over MCP, for clients that speak it          |
| `GET /docs`            | Swagger UI over the generated OpenAPI document              |

Serve and click redirects append `_lvt`/`_lvid`/`_lvvar` so the SDK on the
destination site can adopt the assignment (`decorateRedirects: false` opts
out).

### Using it from an AI assistant

Everything an assistant can do lives in one registry (`@livevariant/tools`),
and every surface is generated from it: the MCP server registers those
tools, the REST API mounts them, the OpenAPI document describes them, and
the agent SKILL documents them. Nothing about a tool is written down
twice, and CI regenerates and fails on any diff.

| Tool                  | What it does                                           |
| --------------------- | ------------------------------------------------------ |
| `build_test`          | Variants in, URLs and a stats secret out               |
| `inspect_test`        | Decode any test URL and lint it                        |
| `recommend_algorithm` | ts / bucketed / linear, with reasoning                 |
| `generate_priors`     | Turn a prediction into capped warm-start pseudo-counts |
| `get_stats`           | Results, win probabilities and a stop/continue call    |
| `variant_brief`       | Channel-specific constraints for drafting the variants |

The hosted endpoint at `https://livevariant.com/mcp` needs nothing
installed. Install the plugin (this repository is the marketplace):

```bash
claude
/plugin marketplace add livevariant/livevariant
/plugin install livevariant@livevariant
```

Or run the MCP server directly:

```bash
npx -y @livevariant/mcp
```

There is no authentication and none is missing: a test is its config, and
reading results needs the stats secret that the server checks against the
hash inside that config, so authority travels in the arguments. Set
`LIVEVARIANT_SERVER_URL` to point the tools at a self-hosted deployment.

**Three ways in, one implementation.** The same registry is served as MCP
over stdio (`npx -y @livevariant/mcp`), as MCP over HTTP at `/mcp` for
clients that cannot spawn a local process, and as plain `POST
/api/v1/<tool-name>` for agents that speak neither, documented at `/docs`
and `/openapi.json`. All of them call the identical handler, so they
cannot disagree.

**One domain, no configuration.** A deployment serves everything from
wherever it runs, and every URL it hands out is built from the origin the
request arrived on, so a self-host needs no environment variables at all.
Set `LV_SERVE_URL` only to put the links visitors follow on a separate
domain, which is worth doing for bulk email so a campaign's reputation
never touches the dashboard's. That is the only thing it changes: both
domains still answer for everything, and the manage link still points
where the creator was working.

The hosted MCP endpoint is stateless, because every tool is a pure
function of its arguments, so there is no session to keep and no question
about affinity across Worker isolates.

`get_stats` is the one worth knowing about. It returns the probability
each variant is genuinely best and the expected cost of stopping now,
because comparing conversion rates by eye is how tests get called wrong: a
variant ahead 2/10 to 1/10 looks twice as good and is close to a coin
flip. It also refuses to call a test that has barely run.

### The SDK never breaks a page

`createTest` resolves even when LiveVariant is unreachable, slow, or
answering with something unusable: it renders the first arm (your
control) and sets `test.fallback = true`. Fallback views are deliberately
not cached and not recorded, so an outage cannot pin a visitor to control
for good or quietly distort a test's numbers. Assignment requests give up
after `timeoutMs` (2s default), and `trackConversion()` never rejects,
because a customer may await it inside their own checkout.

### Trust model

Configs are unauthenticated by design: the URL is the test. That has two
consequences worth stating plainly.

- **The tool API is unauthenticated too**, and mounts only when `LV_API_URL`
  is set. It builds and inspects configs and proxies stats reads, all of
  which a caller could do offline with the same inputs, so it grants no
  authority the config and its secret did not already carry.
- **Serving endpoints are redirectors.** Anyone can author a config
  pointing anywhere, so set `LV_ALLOWED_DESTINATIONS` (comma-separated
  hosts) on a public deployment to keep your domain out of phishing
  reports. Unset means allow-all, which is the right default for a
  self-host serving its own campaigns.
- **JS-mode serving is unauthenticated.** `/choose` and `/reward` take a
  public `testId`, so the server pins each test's shape (arm count,
  algorithm, dimension) on first sight and rejects callers that disagree.
  Someone who knows a testId can still add same-shape assignments, so
  treat a public test's numbers accordingly.

  Every assignment records an opaque source bucket: a per-test,
  daily-rotating hash of the writer's address prefix (/24 or /48). The
  address itself is never stored, and the hash is neither cross-test nor
  long-lived. `/stats` breaks assignments down by bucket so you can see
  where traffic came from, and `POST /exclude/:cfg` (stats secret)
  quarantines a bucket or a time window and recomputes, which heals
  history because derived state is a pure function of the event log.

  Nothing is excluded automatically, and there is no rate limiting.
  Source buckets are address prefixes, and Gmail, Yahoo, and Outlook
  fetch email images through their own infrastructure, so an entire
  campaign's opens legitimately share a handful of provider prefixes
  (link scanners add more). Any automatic rule would discard most of a
  real send while reporting the remainder with full confidence, and a
  confidently wrong number is worse than a noisy one. For the same
  reason, serving is never rate limited: prefix limits punish exactly the
  shared infrastructure that legitimate email and corporate traffic sits
  behind.

### Running tests in email

Two things are not optional:

- **Give every recipient a distinct `?id=`** (your ESP's merge tag).
  Without it, every recipient shares one URL, the mail provider caches a
  single fetch, everyone sees the same variant, and the whole campaign
  records one assignment.
- **Expect provider infrastructure in the numbers.** Image opens come
  from the provider's proxy, not the recipient, and security scanners
  prefetch links. Clicks and on-site conversions are the trustworthy
  signals; raw opens are not, which is true of every email tool.

One thing that is optional but usually right: append `?auto=0` to email
links (`buildTestUrls` returns them ready-made as `noAuto.serve` and
`noAuto.click`) to switch server-derived context off for that link.

Proxy detection already discards derived context for image fetches, but
it is a header heuristic and corporate link scanners defeat it on
purpose, following links from a datacenter while presenting ordinary
browser headers. The reason it matters more than a few wrong rows is that
assignment is sticky: whichever request arrives first fixes a recipient's
bucket permanently, and in an email carrying both an image and a link
that is the image open. So derived context in email is unreliable _and_
order-dependent. `?auto=0` makes the behaviour declared instead of
guessed. Context you merge in yourself (`&c_country=nl`) is unaffected,
and the flag is per link, so the web half of a campaign keeps its
context.

### Tests an ESP template can build

A config does not have to be base64. The same test can be spelled out in
plain query parameters, and the two forms parse to the same `TestConfig`
and therefore the same `testId`:

```
https://livevariant.link/s?v=https://cdn.example.com/hero-1.jpg
                          &v=https://cdn.example.com/hero-2.jpg
                          &id={{recipient_id}}
                          &kh=<statsKeyHash>
```

The fixed hash goes last so the fields a campaign manager actually edits
sit at the front of the URL, where they are readable without scrolling
past 64 characters of hex.

Only `v` is required, twice or more. Everything else defaults, because
nobody filling in a template field should have to know this system has an
algorithm, let alone pick one.

This is what makes the interesting workflow possible. Someone wires the
template once with the fixed parts (`k`, and whatever the test needs);
campaign managers then fill only the variant fields through the ordinary
template editor. They never encode anything and never visit this service.
Because the variant URLs are inside the identity hash, each campaign
automatically becomes its own test, while the one stats secret opens all
of them.

| Param   | Meaning                                                    |
| ------- | ---------------------------------------------------------- |
| `v`     | Variant target URL, repeated; the first one is the control |
| `vn`    | Variant name, repeated, positional (defaults v1, v2, …)    |
| `kh`    | `statsKeyHash`, the **hash** of the stats secret           |
| `alg`   | `ts`, `bucketed` or `linear`                               |
| `ctx`   | Dimensions: `source:utm_source,persona`                    |
| `r`     | Fallback click-redirect target                             |
| `stamp` | Write the served variant into this param on redirect       |
| `fw`    | `fw=0` stops unrecognized params being forwarded           |
| `n`     | Test name                                                  |

`kh` is the hash, never the secret. It is already public in every serve
URL, so it is safe in a link that reaches every recipient; the secret
itself only ever appears in the manage link's `#fragment`. A test with no
`kh` still serves and learns, but nothing can read it, because no secret
matches a hash that is not there.

Two behaviours worth knowing:

- **It fails open.** These URLs are assembled by hand, so a wrong one is
  a broken image in front of the entire recipient list. If the config
  will not parse but anything looks like a variant, the first one is
  served and no test runs. A campaign degrades to "not measured", never
  to a hole in the layout.
- **Attribution is carried through.** Any parameter we do not recognize
  (`utm_source`, `gclid`, `mc_cid`) is appended to the redirect target,
  so the customer's analytics keeps working across the hop. Parameters
  already on the destination win, and `fw=0` turns it off. Setting `stamp`
  (typically `stamp=utm_content`) additionally writes the served variant's
  name onto the destination, which puts the test into the customer's own
  reporting without them installing anything.

### Context the caller never has to send

A context dimension can declare `from`, and the server fills it from the
request itself:

```jsonc
{
  "ctx": {
    "dims": [
      { "key": "country", "from": "country" },
      { "key": "device", "from": "device" },
      { "key": "persona" } // still supplied by you
    ]
  }
}
```

Signals come in two kinds, and the difference matters:

- **Network signals** are guessed from the connection: `country`,
  `continent`, `region`, `city`, `timezone`, `device`, `language`,
  `organization`. Geo comes from Cloudflare's `request.cf` and is simply
  absent on other hosts; `device` and `language` come from headers and
  work anywhere.
- **Campaign tags** are read off the link: `utm_source`, `utm_medium`,
  `utm_campaign`, `utm_content`, `utm_term`. Most marketing URLs already
  carry them, so a test can segment by traffic source with nothing added
  by the customer at all.

Only the first kind can be wrong here. A proxy answers every network
signal about itself, but relays the URL the sender wrote untouched, so a
campaign tag is as true for Gmail's fetcher as for the reader. That makes
tags the one sort of derived context that works properly in email, and it
is why proxy detection and `?auto=0` suppress the guessed signals and
leave the tags alone.

This is what makes an email redirect contextual: there is no JavaScript
in an inbox, and the sender usually does not know the reader's country
either. A value you supply yourself (`?c_country=nl`, or `context` in the
SDK) always wins, because you know your own users better than an IP
database does. A declared `values` list still applies, so a signal can
never invent a bucket the config did not sanction.

Two details worth knowing:

- **One context is one bucket, on every channel.** A supplied value and a
  derived one are composed identically, so a campaign that emails people
  and then tracks them with the SDK on the landing page learns from all
  of its traffic at once instead of splitting it in half.
- **Proxied fetches derive nothing.** Mail providers fetch email images
  from their own infrastructure, so that geo is a datacenter, not the
  reader. Only a page navigation counts as a person: an image request, a
  bare `Accept: */*`, and a request with no headers are all treated as
  proxies. Guessing "proxy" for a real visitor costs only their context,
  while the reverse silently files datacenter geo as real. No context
  beats confidently wrong context. It is still a heuristic, so for email
  prefer the explicit `?auto=0` links described above.

All signals are recorded on every assignment, not only the ones a test
uses as context, so `/stats` returns a `bySignal` breakdown even for a
plain non-contextual test.

### Advice from what the test actually saw

Declared dimensions lie. A free-form persona tag or a `city` dimension
looks like one dimension and fragments into thousands of buckets that
each starve and fall back to the global model. `/stats` therefore returns
a `suggestion` computed from the observed bucket count and traffic, e.g.
a `bucketed` test averaging too few pulls per bucket is told to switch to
`linear`.

Acting on it costs nothing: `alg` is excluded from the identity hash, so
changing it keeps the same testId, and `POST /recompute` rebuilds the
model from the full event log. No history is lost.

## Run your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant)

That clones this repository into your own GitHub account, provisions the
Durable Object, and deploys. You get a `workers.dev` URL serving
everything: the dashboard, the tools API, `/docs`, the MCP endpoint and
the serving redirects. Nothing to configure, because every URL a test
hands out is built from the origin the request arrived on.

Two optional variables, both offered during setup:

| Variable                  | Why you might set it                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `LV_SERVE_URL`            | A second domain for campaign links, so bulk email never touches your dashboard's reputation |
| `LV_ALLOWED_DESTINATIONS` | Comma-separated hostnames redirects may point at. Set this on anything internet-reachable   |

Or deploy it yourself:

```bash
npm install
npm run build
npm run deploy
```

That deploys the top-level configuration, which is the one meant for any
account but ours: a single `workers.dev` origin, no routes, and every URL
built from the request. Nothing to configure.

Our own deployment is `npm run deploy:livevariant`, named after us because
it carries routes for zones only we own. Anything named for this project is
ours; plain `deploy` is yours.

`LV_ALLOWED_DESTINATIONS` deserves a moment's thought before you expose a
deployment publicly. Anyone can author a config pointing anywhere, so an
open deployment is an open redirector; the allowlist is what stops yours
being used for phishing. Unset means allow-all, which is right while you
are only serving your own campaigns.

## Development

Requires Node 24 (`nvm use`) and npm.

```sh
npm ci
npm run build
npm test
npm run lint
```

The repo is an [nx](https://nx.dev) workspace; `npx nx graph` shows the
project layout.

## License

[AGPL-3.0](LICENSE). Self-hosting for your own use is unrestricted; if you
modify LiveVariant and offer it to others as a network service, the AGPL
requires you to publish your modifications.
