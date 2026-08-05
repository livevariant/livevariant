# LiveVariant — project guide

Open-source (AGPL) adaptive A/B testing. The entire test configuration
travels base64url-encoded in the URL: no accounts, no registration. One
joint linear Thompson sampling model serves every test (plain A/B,
contextual, multi-slot); traffic shifts continuously, a different winner
can emerge per audience segment, and tests never end. Built to be driven
by LLM agents as much as by people.

## Design system

Always read `DESIGN.md` before making any visual or UI decision. Fonts,
colors, spacing, motion, content architecture and copy doctrine are
defined there. Do not deviate without explicit user approval. In QA,
flag code that does not match DESIGN.md.

## Core concepts

- **The config is the test.** Slots, variants and context dims are
  encoded in the URL; `testId = sha256(canonical config minus excluded
fields)`. Tampering derives a different test with empty state.
  Identity-EXCLUDED (change without resetting the test): `priors`,
  `priorStrengthCap`, `decorateRedirects`, `variantParam`,
  `forwardParams`. Everything else (slots, ctx, `region`, `scope`,
  `statsKeyHash`, `rewardEvents`, redirects) is identity-INCLUDED.
- **One model, zero choices.** No algorithm field exists. Every test
  runs joint linear Thompson sampling over hashed binary features
  (`packages/core/src/model.ts`): bias + context + slot-variant mains +
  slot x slot pairs + ctx x variant pairs. `dimForShape` sizes the
  dimension (16..256); `MODEL_NOISE` is fixed. Serving samples theta
  once and enumerates all cells exactly (max 512).
- **Slots and cells.** A test is one or more slots, each with variants;
  the action space is their cartesian product. A combination is one
  integer cell, row-major over SORTED slot keys (`cells.ts`). Cap:
  `MAX_CELLS = 512`. Single-slot tests use `variants:` sugar; bare
  string variants URL-sniff into `{url}` or `{text}`.
- **Event sourcing.** One `AssignmentRecord` per (testId, idHash) is the
  source of truth; counters and the model blob are a derived cache.
  Records store the full serve-time `featIdx`, `slotSizes` and `dim`,
  so replay never re-hashes and `recomputeState` provably equals the
  incremental path (`recompute.spec.ts`). Hostile/stale records are
  skipped, never fatal.
- **Priors.** Per-slot-variant `{mean, strength}`, capped by
  `priorStrengthCap` (server ceiling 50), applied as pseudo-observations
  on the variant's main-effect coordinate. Identity-excluded;
  `POST /recompute` applies changes to full history.
- **Stats secret.** `statsKeyHash` in the config is the sha256 of a
  creator-held secret; `/stats`, `/recompute`, `/exclude` take it as a
  Bearer header only (query params would hit logs). The manage URL
  carries it in the `#fragment`. No hash in the config = stats
  unreadable forever, by design.
- **Region.** Optional config field: a Durable Object location hint
  (`wnam` `enam` `sam` `weur` `eeur` `apac` `oc` `afr` `me`) or `"eu"`
  = EU JURISDICTION (state guaranteed inside the EU; physically a
  different object). Identity-included so tampering self-isolates. Rides
  on config-free paths: `/choose` and `/reward` bodies, `_lvr` handoff
  param. Defaults to the creator's region (`regionHint` from
  `request.cf`; `/config` exposes it to the builder).
- **Scope.** Keyless inline SDK configs get `scope: location.hostname`
  injected so two sites running the same trivial test never share
  state. Explicit `scope` overrides; keyed or pre-encoded configs are
  never touched.

## Architecture

| Package                 | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `@livevariant/core`     | Config codec, identity, the joint model, cells, priors, state |
| `@livevariant/server`   | Hono app behind pluggable `StateStore` + `TestBackend`        |
| `@livevariant/workers`  | Cloudflare: one SQLite Durable Object per test                |
| `@livevariant/sdk`      | Browser SDK: sticky combinations, GA auto-rewards, handoff    |
| `@livevariant/tools`    | ONE registry of agent operations: MCP, REST, OpenAPI, SKILL   |
| `@livevariant/mcp`      | MCP server (stdio) over that registry                         |
| `@livevariant/accounts` | Hosted-only: Better Auth + Drizzle/D1 ownership registry      |
| `apps/web`              | livevariant.com: site + builder + stats/manage (React/shadcn) |

Two Worker entries: `packages/workers/src/index.ts` (self-host `main`,
never imports accounts; a bundle-assertion spec proves it) and
`index.hosted.ts` (`env.production.main`, wires `@livevariant/accounts`
when the D1 binding and secrets exist). Shared options come from
`baseAppOptions` so the entries cannot drift. `packages/server` reaches
accounts only through two dependency-free ports: `TrustPolicy`
(origins + redirect verdicts, `trust.ts`) and `AccountsProvider`
(sessions, claimed keys, registered tests, `accounts-port.ts`).

### HTTP surface

| Endpoint                                                      | Purpose                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /s/:cfg`, `GET /s`                                       | Serve: assign combination, 302 to one slot's content (`?slot=` for multi-slot)                                                                                           |
| `GET /c/:cfg`, `GET /c`                                       | Click: reward + redirect (`?to=` must match config origins)                                                                                                              |
| `GET /px/:cfg`                                                | 1x1 gif conversion pixel (never errors outward)                                                                                                                          |
| `POST /choose`                                                | JS mode, content-free: `{testId, slotSizes, dim, region?, priors?, idHash?, ctxKey?, featIdx?, autoDims?, autoCtx?, assets?}` in, `{cell, choice, assetSignatures?}` out |
| `POST /reward`                                                | `{testId, idHash, amount?, region?}`                                                                                                                                     |
| `GET /stats/:cfg`                                             | Creator-only: combinations, per-slot marginals, buckets, bySignal, perSource, excluded                                                                                   |
| `POST /recompute/:cfg`                                        | Rebuild derived state from the event log                                                                                                                                 |
| `POST /exclude/:cfg`                                          | Quarantine source hashes / time windows, then recompute                                                                                                                  |
| `POST /api/v1/*`, `/mcp`, `/docs`, `/openapi.json`, `/config` | The tool registry surfaces + deployment info (gated by `LV_API_TOKEN` when set)                                                                                          |
| `/auth/*`, `/account/*`                                       | Hosted only: Better Auth + registry REST; credentialed CORS, host-gated to the dashboard domain, the only prefixes with cookies                                          |

`/manage/:cfg` is a DASHBOARD route (apps/web, SPA fallback), not a
server one: the secret stays in the `#fragment` and one React page
(`TestDetail`) serves saved tests and manage links alike.

Handoff params on redirects: `_lvt` (testId), `_lvid` (idHash), `_lvvar`
(cell), `_lvr` (region, when set). Query config form: `v` `vn` `s` `n`
`kh` `ctx` `r` `stamp` `fw`; runtime: `id` `auto` `to` `slot`.

## Trust model (the parts that bite)

- `/choose`/`/reward` are unauthenticated writes on a PUBLIC testId.
  The server pins each test's shape `{slotSizes, dim}` on first sight
  (`pinShape`; decoded-config callers are authoritative) and rejects
  disagreement. Never trust client-declared serving parameters without
  that pin.
- Every assignment records `srcHash` (per-test, daily-rotating hash of
  the /24 or /48 prefix) and readable coarse `signals`. Nothing is
  excluded automatically and there is NO rate limiting: mail-provider
  proxies legitimately concentrate a whole campaign into a few
  prefixes. `applyExclusions` + recompute heal history retroactively.
- Redirects are an open-redirector risk. The `TrustPolicy` port
  decides per destination: allow, block, or "interstitial" (an explicit
  "Redirecting you to…" continue screen, navigations only, decided once
  per test so variants get equal friction). Env knobs:
  `LV_ALLOWED_DESTINATIONS` + `LV_UNLISTED_DESTINATIONS`; the hosted
  deployment runs interstitial-unless-verified through the accounts
  registry. Hosted-asset URLs count as "ours" only when path AND host
  match.
- Ownership is per stats KEY (`kh`), never per test: one secret spans
  every campaign built from it. Claims are single-statement D1 upserts
  (race-free by primary key). `lockReads` trades the bearer capability
  for org sessions on the creator-only endpoints; a locked key 401s
  exactly like a wrong secret. Secrets cannot rotate (kh is inside the
  identity hash).
- SDK registration (`publishableKey` + `encoded` on /choose) is opt-in
  consent for a JS-mode config to reach the server, requires the page
  origin's domain verified by the key's org, runs in `waitUntil`, and
  grants nothing beyond registration.
- Email signals doctrine: network signals (geo/device) from image
  fetches describe the mail proxy, not the reader; assignment is
  sticky so the first fetch wins. `?auto=0` links, proxy detection, and
  utm campaign tags (proxy-proof) exist for this. Web/SDK examples may
  use country/device; email examples must use `utm_*` or merge-tag
  values.

## Storage

`StateStore` (`packages/server/src/store/types.ts`) = event log
(`putAssignmentIfAbsent`, `addReward`: MUST be atomic, failures are
permanent) + derived cache (`incrCounters`, `putBlob` CAS,
`replaceDerived`: repairable via recompute). Conformance suite:
`import { storeContract } from "@livevariant/server/testing"`. The DO
gets serialization for free; `ModelCache` (keyed by testId + blob
version, copy-in/copy-out) makes decoded models hot; the model blob is
JSON on purpose (benchmarked against base64-Float64: JSON is smaller
and faster in V8; see `snapshot.ts`).

## Development

Node 24 (`nvm use`), npm, nx monorepo.

```bash
npm ci
npm run build              # nx run-many -t build
npm test                   # all, incl. Playwright browser tests (sdk, web)
npm run test:no-browser    # CI-safe subset
npm run lint && npm run typecheck
npm run generate           # regenerate skills/livevariant/SKILL.md + plugins; CI fails on diff
npm run dev:worker         # wrangler dev, env "dev": hosted entry + local D1 accounts.
                           # First time: npm run migrate:local, and put a random
                           # LV_AUTH_SECRET in .dev.vars. Without a Resend key the
                           # magic sign-in link prints to this terminal.
npm run release            # lockstep versioning: ALL five npm packages, one version, every release
```

- Simulation tests in `packages/core/src/model.spec.ts` earn the
  one-model claim (3x3 interaction trap vs independent bandits, priors
  lean/washout); they have a 60s testTimeout for slow CI.
- Workers Builds runs `npm run build && npm run test:no-browser` and
  deploys `livevariant-production` on push.
- `wrangler` env bindings: `durable_objects` must be repeated inside
  `env.production` (not inherited); `migrations` is inheritable.
- nx cache can mask env-dependent results: `--skip-nx-cache` when
  varying anything outside the repo.

## Conventions

- Tools live ONLY in the `@livevariant/tools` registry; MCP, REST,
  OpenAPI and SKILL are all generated from it. Never hand-edit
  `skills/` or `plugins/` (edit `skill/SKILL.template.md` +
  `scripts/generate-agent-assets.mjs` inputs, then `npm run generate`).
- Deployment split: plain `npm run deploy` is the anyone's-account
  config; anything named `*:livevariant` carries our zones and is ours.
- `LV_SERVE_URL` optional second domain for campaign links;
  `LV_ASSET_SECRET` + R2 `ASSET_STORE` enable hosted images (content
  addressed, HMAC-signed URLs, SVG refused).
