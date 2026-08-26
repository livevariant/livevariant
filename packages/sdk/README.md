# @livevariant/sdk

Browser SDK for [LiveVariant](https://livevariant.com): sticky variant
assignment with client-side hashing (raw ids and context never leave the
page), and zero-setup conversion tracking via Google Analytics dataLayer
interception. `createTest` never rejects: if the server is unreachable it
renders your control and marks the result as a fallback, so a test can
never break a page.

By default the SDK stores nothing that outlives the page: identity,
cached assignments and redirect handoffs live in a window-shared page
store, so there is no cookie or storage consent to collect. Deployments
that want cross-page identity and pages-later conversions opt into
localStorage explicitly (`storage: window.localStorage` in code,
`data-storage="local"` on the tag) and own that consent story.

Part of [livevariant/livevariant](https://github.com/livevariant/livevariant);
the repository README covers the whole system. AGPL-3.0.
