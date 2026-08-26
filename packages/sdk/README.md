# @livevariant/sdk

SDK for [LiveVariant](https://livevariant.com), in the browser and
headless (node, agents, CI): sticky variant assignment with client-side
hashing (raw ids and context never leave the client), and zero-setup
conversion tracking via Google Analytics dataLayer interception.
`createTest` never rejects: if the server is unreachable it
renders your control and marks the result as a fallback, so a test can
never break a page.

Client state (identity, cached assignments, redirect handoffs) defaults
to **sessionStorage**: per-tab, expiring with the session, holding only
functional A/B state, which is the storage posture that needs no
consent banner. No cookie is read or set by default either. Two
declared modes move off the default, each a deployment decision:
`storage: "local-storage"` upgrades persistence to cross-visit
localStorage (the deployment's own consent story), and
`storage: "none"` touches no web storage at all, running instead on a
window-shared in-memory store so tests stay sticky and rewardable for
the page's lifetime. A separate opt-in, `autoIdentify: true`, reads the
site's own `_ga` cookie so test identity follows the site's analytics
identity, under the site's GA consent flow. Every knob has the same
three spellings: an option in code, a `data-*` attribute on the tag, a
plain string or boolean in the page's global config. Headless there is
no web storage for any mode to reach: state lives in the SDK's own
in-memory store for the life of the process (details below).

Part of [livevariant/livevariant](https://github.com/livevariant/livevariant);
the repository README covers the whole system. AGPL-3.0.

## Headless: node scripts, agents, CI

`createTest` also runs where no `window` exists — a node script, an
agent's tool call, a CI smoke test — with no shim and nothing beyond a
`serverUrl`:

```js
import { createTest } from "@livevariant/sdk";

const test = await createTest(
  { variants: ["Buy now", "Get started"] },
  { serverUrl: "https://livevariant.com" }
);
console.log(test.variant.text);
await test.trackConversion();
```

What replaces the browser surface, exactly:

- **Identity.** Pass `externalId` to control it (one value per user you
  serve); otherwise a generated id is kept in process memory, so one
  process is one visitor. Assignments stay sticky across processes
  either way — the server keys them by test and id hash.
- **Storage.** Real node has no web storage, so every storage mode
  resolves to the SDK's own in-memory window store, held for the life
  of the process — the same store `storage: "none"` uses on a page.
  Identity and cached assignments live there.
- **Scoping.** A page scopes keyless inline configs to its hostname;
  headless there is no hostname, so keyless configs stay unscoped. To
  join a test a page is serving, pass the encoded config string (or the
  same explicit `scope`).
- **Conversions** are explicit: call `test.trackConversion()`. GA
  dataLayer interception is a page mechanism and never starts headless.

Requires a runtime with `fetch`, `crypto`, and `AbortSignal.timeout`
(node 20+, workers, deno).
