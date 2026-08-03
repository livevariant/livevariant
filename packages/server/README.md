# @livevariant/server

[LiveVariant](https://livevariant.com)'s serving backend as a library: the
Hono app (redirect/click/pixel serving, JS-mode choose/reward, secret-gated
stats, the tool API and a hosted MCP endpoint) behind a pluggable
`StateStore`. Mount `createApp` inside your own app, or skip HTTP and call
`TestService` directly. Bring your own storage and prove it with the
conformance suite at `@livevariant/server/testing`.

Part of [livevariant/livevariant](https://github.com/livevariant/livevariant);
the repository README covers the whole system, including the storage
concurrency contract. AGPL-3.0.
