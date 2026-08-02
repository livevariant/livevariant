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

| Package             | Purpose                                                 |
| ------------------- | ------------------------------------------------------- |
| `@livevariant/core` | Config codec, hash identity, bandit math, priors, state |

Server (Hono, Cloudflare Workers/Node), browser SDK, and MCP server
packages are in progress; see the repository issues/roadmap.

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
