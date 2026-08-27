# LiveVariant: project guide

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
  `ctxPriors`, `priorStrengthCap`, `decorateRedirects`, `variantParam`,
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
  on the variant's main-effect coordinate. `ctxPriors` blocks carry the
  same per-slot shape under a `when` (dimension key to value) and land on
  the (context x variant) INTERACTION instead, which is the only way to
  say "image B is the one for the blue segment" rather than "for
  everybody"; the context feature index is a pure function of
  `key=value` and the dimension, so a segment's prior is placeable with
  no visitor from that segment present. Both identity-excluded;
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
- **Resolved context.** A ctx dim can say `resolve: "<name>"` instead of
  `from:`, for buckets that are a LOOKUP rather than a signal (a postcode
  becomes a segment). The deployment supplies the named resolver
  (`AppOptions.ctxResolvers`, port in `server/src/ctx-resolver.ts`); it
  runs inside `resolveIdentity` between normalizing and hashing, reads the
  caller's RAW ctx (so the input need not be a declared dim), and only its
  answer reaches `ctxKey`/`featIdx`. Fails open on rejection, timeout
  (`ctxResolveTimeoutMs`, default 150ms) or a value outside `values`.
  Redirect paths only: `/choose` carries a page-computed hash by design.
  Records store serve-time `featIdx`, so recompute never re-resolves.
- **Scope.** Keyless inline SDK configs get `scope: location.hostname`
  injected so two sites running the same trivial test never share
  state. Explicit `scope` overrides; keyed or pre-encoded configs are
  never touched.
- **Session-scoped storage by default.** The browser SDK writes no
  cookies, and its client state (identity `lv:id`, assignments `lv:a:*`,
  handoffs `lv:h:*`) defaults to sessionStorage: per-tab, expiring with
  the session, functional A/B state only, the posture that needs no
  consent banner. Modes (`sdk/src/page-store.ts`, `storage:` option /
  `data-storage` / global config): `"session-storage"` (default),
  `"local-storage"` (cross-visit persistence, the deployment's consent
  story), `"none"` (no web storage at all: a window-shared in-memory
  store keeps tests sticky and rewardable for the page's lifetime; also
  the fallback when a chosen web storage throws, and what unknown future
  modes degrade to). The window store hangs on the window because the
  tag and an npm bundle coordinate rewards through those keys, and the
  reward watcher scans its own store, every registered store, and both
  web storages. The GA `_ga` cookie is read (never written) for identity
  ONLY under the `autoIdentify` opt-in (option / `data-auto-identify` /
  global config), so the default install reads no cookies either.

## Architecture

| Package                 | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `@livevariant/core`     | Config codec, identity, the joint model, cells, priors, state |
| `@livevariant/server`   | Hono app behind pluggable `StateStore` + `TestBackend`        |
| `@livevariant/workers`  | Cloudflare: one SQLite Durable Object per test                |
| `@livevariant/postgres` | Postgres `StateStore` + drizzle schema, for Node hosts        |
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

| Endpoint                                                           | Purpose                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /s/:cfg`, `GET /s`                                            | Serve: assign combination, 302 to one slot's content (`?slot=` for multi-slot)                                                                                                                                                                                                |
| `GET /c/:cfg`, `GET /c`                                            | Click: reward + redirect (`?to=` must match config origins)                                                                                                                                                                                                                   |
| `GET /px/:cfg`                                                     | 1x1 gif conversion pixel (never errors outward)                                                                                                                                                                                                                               |
| `POST /choose`                                                     | JS mode, content-free: `{testId, slotSizes, dim, region?, priors?, idHash?, ctxKey?, featIdx?, autoDims?, autoCtx?, assets?}` in, `{cell, choice, assetSignatures?}` out                                                                                                      |
| `POST /reward`                                                     | `{testId, idHash, amount?, region?}`                                                                                                                                                                                                                                          |
| `GET /stats/:cfg`                                                  | Creator-only: combinations, per-slot marginals, buckets, bySignal, perSource, excluded                                                                                                                                                                                        |
| `GET /stats/:cfg/stream`                                           | Same payload over SSE: `stats` events on change, `ping` between; consumed via streaming fetch (Bearer header)                                                                                                                                                                 |
| `POST /recompute/:cfg`                                             | Rebuild derived state from the event log                                                                                                                                                                                                                                      |
| `POST /exclude/:cfg`                                               | Quarantine source hashes / time windows, then recompute                                                                                                                                                                                                                       |
| `POST /api/v1/*`, `/mcp`, `/docs`, `/openapi.json`, `/config`      | The tool registry surfaces + deployment info (gated by `LV_API_TOKEN` when set)                                                                                                                                                                                               |
| `/llms.txt`, `/.well-known/*`, `/auth.md`, `/sitemap.xml`, `GET /` | Agent discovery, all per request origin: llms.txt, RFC 9727 api-catalog, MCP server card, agent-skills index (skill digest), the no-auth story, sitemap; `/` negotiates `Accept: text/markdown` and carries RFC 8288 Link headers (browsers get the SPA shell via `spaFetch`) |
| `/auth/*`, `/account/*`                                            | Hosted only: Better Auth + registry REST; credentialed CORS, host-gated to the dashboard domain, the only prefixes with cookies                                                                                                                                               |

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

## Inference: what the numbers do and do not mean

A statistical audit (`docs/experiments/AB_TESTING_REVIEW.md`, every number in
it produced by porting this repo's own numerics to Python and simulating them)
found the SERVING correct and four things wrong with the REPORTING. Read this
before touching `decide.ts` or `stats-derive.ts`; the reasoning is easy to
rediscover the hard way.

- **Adaptive allocation biases the reported rates.** A starved arm's sample
  mean is low by ~11% of its true value (5% vs 10%, 300 replications), and
  Wilson coverage drifts to ~0.94 against a nominal 0.95. This is expected,
  not a bug: Nie, Tian, Taylor & Zou (2018, AISTATS) prove the negative bias
  for optimism-driven algorithms including Thompson sampling; Shin, Ramdas &
  Rinaldo (2019, NeurIPS) characterize the sign per arm. The bandit is
  supposed to starve the loser. The defect is presenting adaptively collected
  counts with the visual grammar of a fixed-design experiment. Do NOT "fix" it
  by widening the interval: that repairs coverage and leaves the point
  estimate wrong. The surfaces mark thin-exposure variants
  (THIN_EXPOSURE_SHARE), and every stored serve now records its propensity
  (AssignmentRecord.propensity, PROPENSITY_DRAWS extra draws off the serve's
  own Cholesky factor), which is the input the adaptively-weighted AIPW
  estimator of Hadad, Hirshberg, Zhan, Wager & Athey (2021, PNAS 118(15),
  doi:10.1073/pnas.2014602118) needs per record. The estimator itself is the
  remaining open piece.
- **`canStop` is a per-look quantity.** It bounds posterior expected loss at
  ONE evaluation; a dashboard polls until it fires, which is optional
  stopping. Measured over 5% vs 6%, realized regret was 2.59% of the best rate
  against the 1% the threshold reads like. Johari, Koomen, Pekelis & Walsh
  (2022, Operations Research 70(3), doi:10.1287/opre.2021.2135) is what a rule
  that survives continuous monitoring requires; Loecher (2021,
  doi:10.3389/frai.2021.715690) covers the bandit case. The wording no longer
  promises a bound. The threshold's VALUE is unchanged and changing it is a
  separate decision.
- **Per-bucket analysis is partially pooled** (Gelman, Hill & Yajima 2012,
  doi:10.1080/19345747.2011.618213). It used to be a fresh flat-prior analysis
  per bucket, which showed a false segment winner at P(best) >= 95% in 52.7%
  of null 8x2 runs. Each bucket's prior is now the whole test's rate per arm
  at BUCKET_POOLING_STRENGTH pseudo-observations, on top of the
  `MIN_BUCKET_PULLS_TO_CALL` exposure gate. Know what pooling can and cannot
  fix before touching the constant: it kills the SEGMENTATION illusion (a
  confident bucket contradicting the global leader: 16-18% of null runs
  unpooled, ~1% pooled, measured in stats-derive.spec.ts), but a bucket
  echoing the global result's own premature confidence converges to the
  global null rate however strong the prior, and that is the tie wording's
  job. A bucket's `leaderRate` is the shrunk posterior mean, not the raw
  ratio; the raw counts sit beside it.
- **Hash collisions are common and mostly harmless.** 25-56% of features share
  a slot at shipped dimensions. What matters is that no tested shape produced
  same-slot main-effect aliasing and the 3x3 local-optimum simulation reaches
  the global optimum at dim 32, 64 and 128 alike. Weinberger et al. (2009,
  doi:10.1145/1553374.1553516) is the reference, with the caveat that
  `dimForShape`'s ~2x ratio is below the regime its guarantees cover.

**`dim` is load-bearing and unversioned.** It is recomputed from the config on
every serve and every read, while `featIdx` is hashed modulo it and STORED per
record. So changing how `dim` is computed does not change a test id and does
not reset a test: it silently re-points every historical feature, and
`recomputeState` cannot repair it because it replays the stored indices and the
raw context is not retained. `legacyDimForShape` exists for exactly this
reason. Never change the sizing a live test was created under.

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

`@livevariant/postgres` is the other adapter, for Node hosts. Everything
the contract calls atomic is ONE statement there (no-op `DO UPDATE` so
`RETURNING` fires on the conflict path, `xmax = 0` to tell an insert
from a conflict, a `WHERE` on a `DO UPDATE` for the blob CAS); counters
are one row per index, so a serve upserts one row instead of rewriting a
1024-element array. Its `./schema` entry point exports the drizzle
tables so an embedding app can `export * from "@livevariant/postgres/schema"`
and let its own migration chain own them; `ddl.ts` is the same tables as
plain SQL for everyone else, and a spec compares the two. The suite runs
against PGlite by default AND against a real server when
`LV_TEST_POSTGRES_URL` is set (CI sets it). Both matter: PGlite is one
connection, so the concurrency cases serialize there and a
read-modify-write adapter would pass them.

## Development

Node 24 (`nvm use`), npm, nx monorepo.

**Never repair package-lock.json by rerunning `npm install` over it.** npm
prunes the os/cpu variants the current machine does not use whenever it
installs with a node_modules present (npm/cli#7961, #4828), so on a Mac an
incremental rewrite silently deletes every linux binary and hands CI a tree it
cannot build. It has cost this repo two red releases. Rebuild instead:

```bash
rm -rf node_modules package-lock.json && npm install
```

Releases do not touch the lockfile with an install at all: nx's lock-file step
is off (`skipLockFileUpdate` in nx.json) and `scripts/release.mjs` writes the
new versions into the lockfile itself, since a version bump changes numbers it
already knows and needs no resolver. The same script refuses to release a
lockfile that is already missing optional-dependency entries, which is what a
pruned one looks like.

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
npm run release -- --otp=… # lockstep versioning: ALL five npm packages, one version, every
                           # release. Refuses to start without npm login + an OTP (NPM_TOKEN
                           # skips the OTP), and pushes commit + tag itself when publish succeeds.
                           # Publish failed (expired OTP)? No re-versioning needed:
                           # `npm run release -- --continue --otp=…` publishes what's missing + pushes.
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

## Bundle weight

`/sdk.js` goes on customer sites, so its size is a product decision.
`packages/core` therefore uses **`zod/mini`** (`import * as z from
"zod/mini"`, functional API: `z.optional(x)`, `z._default(x, v)`,
`.check(z.minLength(1))`, `z.parse(schema, v)`). The classic
`import { z } from "zod"` is a NAMESPACE object that defeats
tree-shaking completely: one `z.string()` cost 65 KB gzipped, and the tag
was 71 KB gz before the switch and 13 KB after. Call sites use the
exported `parseTestConfig` / `safeParseTestConfig` rather than reaching
for the schema's own methods, so the flavour lives in one file.

`packages/tools` deliberately stays on classic zod (it needs
`.describe()` and JSON Schema emission, and never reaches a browser) and
re-exports `z` so an embedding host can extend a tool's input without a
second zod copy. Classic and mini interoperate: `api-schemas.ts` composes
core's mini `ctxDimSchema` inside a classic `z.array`.

`packages/workers/src/tag-size.spec.ts` holds the ceiling. Raise it
deliberately and say why; do not nudge it to make a build green.

## Conventions

- Git identity: a tool or harness identity (Claude, Codex, or whatever
  default the coding harness ships with) is never the author or
  committer. An agent working on behalf of a person commits as
  that person — before committing, set `git config user.name` and
  `user.email` to THAT person's GitHub account. An autonomous bot with
  no human driving it commits under its own GitHub account (e.g.
  prior-livevariant-bot). An email that maps to no GitHub account fails
  the CLA check on every PR. No AI attribution anywhere: no
  Co-Authored-By trailers, session links, or tool mentions in commit
  messages, PR titles/bodies, or code (`.claude/settings.json` disables
  the automatic ones; don't add them by hand either).
- Tools live ONLY in the `@livevariant/tools` registry; MCP, REST,
  OpenAPI and SKILL are all generated from it. Never hand-edit
  `skills/` or `plugins/` (edit `packages/tools/src/docs.ts` +
  `scripts/generate-agent-assets.mjs` inputs, then `npm run generate`).
- Deployment split: plain `npm run deploy` is the anyone's-account
  config; anything named `*:livevariant` carries our zones and is ours.
- `LV_SERVE_URL` optional second domain for campaign links;
  `LV_ASSET_SECRET` + R2 `ASSET_STORE` enable hosted images (content
  addressed, HMAC-signed URLs, SVG refused).
