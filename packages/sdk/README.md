# @livevariant/sdk

Browser SDK for [LiveVariant](https://livevariant.com): sticky variant
assignment with client-side hashing (raw ids and context never leave the
page), localStorage caching, and zero-setup conversion tracking via Google
Analytics dataLayer interception. `createTest` never rejects: if the
server is unreachable it renders your control and marks the result as a
fallback, so a test can never break a page.

Part of [livevariant/livevariant](https://github.com/livevariant/livevariant);
the repository README covers the whole system. AGPL-3.0.
