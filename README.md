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

  Nothing is excluded automatically. There is an opt-in share cap in the
  code, but it is off by default and should stay off for anything
  touching email: Gmail, Yahoo, and Outlook fetch images through their
  own infrastructure, so an entire campaign's opens legitimately share a
  handful of provider prefixes, and link scanners add more. Automatically
  capping those would silently discard most of a real send, and a
  confidently wrong number is worse than a noisy one.

  There is no rate limiting. Serving must never fail for a real visitor,
  and address-prefix limits punish exactly the shared infrastructure that
  legitimate email and corporate traffic sits behind.

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
