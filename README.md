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

| Package                | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `@livevariant/core`    | Config codec, hash identity, bandit math, priors, state      |
| `@livevariant/server`  | Hono serving app behind a pluggable StateStore + TestBackend |
| `@livevariant/workers` | Cloudflare deployment: one SQLite Durable Object per test    |
| `@livevariant/sdk`     | Browser SDK: sticky variants, GA-driven conversion tracking  |
| `apps/web`             | livevariant.com: product site and account-free test builder  |

An MCP server (LLM-drafted variants and warm-start priors) is next; see
the repository roadmap.

### HTTP surface

| Endpoint               | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `GET /s/:cfg`          | Serve: assigns a variant, 302s to it (email/link mode)      |
| `GET /c/:cfg`          | Click: rewards, then redirects onward                       |
| `GET /px/:cfg`         | 1x1 gif conversion pixel (no-JS thank-you pages)            |
| `POST /choose`         | JS mode: content-free assignment, returns an arm index      |
| `POST /reward`         | JS mode: `{testId, idHash, amount}`                         |
| `GET /stats/:cfg`      | Creator-only stats (Bearer stats secret)                    |
| `POST /recompute/:cfg` | Creator-only: rebuild derived state from the event log      |
| `POST /exclude/:cfg`   | Creator-only: quarantine traffic sources or time windows    |
| `GET /manage/:cfg`     | Creator dashboard shell (secret travels in the `#fragment`) |

Serve and click redirects append `_lvt`/`_lvid`/`_lvvar` so the SDK on the
destination site can adopt the assignment (`decorateRedirects: false` opts
out).

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

Available signals: `country`, `continent`, `region`, `city`, `timezone`,
`device`, `language`, `organization`. Geo comes from Cloudflare's
`request.cf` and is simply absent on other hosts; `device` and `language`
are derived from request headers and work anywhere.

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
