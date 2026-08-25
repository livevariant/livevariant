# @livevariant/sdk

SDK for [LiveVariant](https://livevariant.com), in the browser and
headless: sticky variant assignment with client-side hashing (raw ids and
context never leave the client), localStorage caching, and zero-setup
conversion tracking via Google Analytics dataLayer interception.
`createTest` never rejects an assignment: if the server is unreachable it
renders your control and marks the result as a fallback, so a test can
never break a page.

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
- **Caching** uses that same in-process memory instead of localStorage.
- **Scoping.** A page scopes keyless inline configs to its hostname;
  headless there is no hostname, so keyless configs stay unscoped. To
  join a test a page is serving, pass the encoded config string (or the
  same explicit `scope`).
- **Conversions** are explicit: call `test.trackConversion()`. GA
  dataLayer interception is a page mechanism and never starts headless.

Requires a runtime with `fetch`, `crypto`, and `AbortSignal.timeout`
(node 20+, workers, deno).
