# @livevariant/sdk

Browser SDK for [LiveVariant](https://livevariant.com): sticky variant
assignment with client-side hashing (raw ids and context never leave the
page), and zero-setup conversion tracking via Google Analytics dataLayer
interception. `createTest` never rejects: if the server is unreachable it
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
plain string or boolean in the page's global config.

Part of [livevariant/livevariant](https://github.com/livevariant/livevariant);
the repository README covers the whole system. AGPL-3.0.
