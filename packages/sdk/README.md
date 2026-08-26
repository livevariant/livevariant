# @livevariant/sdk

Browser SDK for [LiveVariant](https://livevariant.com): sticky variant
assignment with client-side hashing (raw ids and context never leave the
page), and zero-setup conversion tracking via Google Analytics dataLayer
interception. `createTest` never rejects: if the server is unreachable it
renders your control and marks the result as a fallback, so a test can
never break a page.

By default the SDK touches nothing in the browser's storage, read or
write: identity, cached assignments and redirect handoffs live in a
window-shared page store that dies with the page, and no cookie is read
or set, so there is no consent to collect for the default install. Two
independent opt-ins relax that, each a deployment decision with its own
consent story: `storage: "local"` (localStorage: cross-page identity and
pages-later conversions) and `autoIdentify: true` (read the site's own
`_ga` cookie so test identity follows the site's analytics identity,
under the site's GA consent flow). Both have the same three spellings:
an option in code, a `data-*` attribute on the tag, a plain string or
boolean in the page's global config.

Part of [livevariant/livevariant](https://github.com/livevariant/livevariant);
the repository README covers the whole system. AGPL-3.0.
