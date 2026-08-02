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
  algorithm, dimension) on first sight and rejects callers that disagree,
  and `LV_RATE_LIMIT_PER_MINUTE` (default 120 per source per minute)
  bounds stuffing.

  Rather than authenticate every visitor, results are made **robust** to a
  minority of adversarial records: each assignment carries an opaque,
  per-test, daily-rotating hash of the writer's address prefix (/24 or
  /48; the address itself is never stored), and no single source may
  contribute more than `max(50, 5%)` of a test's records. Excess records
  stay in the log but are excluded from the model and the reported
  numbers, and `/stats` reports the exclusion tally plus a per-source
  breakdown so you see the judgment instead of trusting it blindly.

  Because derived state is a pure function of the log, the policy is
  **retroactive**: `POST /exclude/:cfg` (stats secret) quarantines a
  source or time window and recomputes, so a test attacked yesterday is
  cleaned up today.

  Honest caveats: a creator holding the stats secret could brute-force a
  /24 back out of a source hash for their own traffic, and an attacker
  distributed across many address ranges can still nudge a test. Carrier
  NAT means many genuine visitors can share one prefix, which is why the
  cap is a generous share with a floor rather than a tight quota.

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
