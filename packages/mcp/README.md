# @livevariant/mcp

MCP server for [LiveVariant](https://livevariant.com): build, inspect and
read adaptive A/B tests from Claude, ChatGPT, Copilot or any MCP
client.

```bash
npx -y @livevariant/mcp
```

Set runtime environment variables before starting the MCP server when you
point it at a self-hosted deployment:

- `LIVEVARIANT_SERVER_URL`: the deployment origin to call.
- `LIVEVARIANT_API_TOKEN`: the deployment's `LV_API_TOKEN`, when `/mcp` or
  `/api/v1/*` is gated.
- `LIVEVARIANT_ASSET_UPLOAD_TOKEN`: the deployment's
  `LV_ASSET_UPLOAD_TOKEN`, when `/assets` is gated.

The hosted endpoint at https://livevariant.com/mcp offers the same tools
with nothing installed.

Part of [livevariant/livevariant](https://github.com/livevariant/livevariant);
the repository README covers the whole system. AGPL-3.0.
