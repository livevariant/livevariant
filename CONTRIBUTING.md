# Contributing to LiveVariant

Thanks for your interest in contributing! LiveVariant is an [Nx](https://nx.dev) monorepo holding the adaptive A/B testing server, SDK, agent tools, and web app. This document explains how to get set up, what we expect from pull requests, and the contributor license agreement you need to sign.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign our [Contributor License Agreement](.github/CLA.md) (CLA).

LiveVariant is stewarded by MSK Holding B.V., which also licenses this code commercially. The CLA grants the company the rights it needs to keep doing that, including the right to relicense your contribution, while you keep full ownership of your work and can use it for any other purpose.

Signing is quick and fully automated:

1. Open your pull request.
2. The CLA Assistant bot posts a comment asking you to sign.
3. Reply to that comment with: `I have read the CLA Document and I hereby sign the CLA`

You only need to do this once; it covers all your future contributions. If you are contributing on behalf of your employer, please also have them complete the [Corporate CLA](.github/CLA-corporate.md).

## Development setup

You need [Node.js 24](https://nodejs.org) (the exact version is in [.nvmrc](.nvmrc), so `nvm use` works) and npm.

```bash
npm ci

# Browser tests run in Chromium via Playwright
npx playwright install --with-deps chromium
```

## Common commands

```bash
npm run build              # Build all packages
npm test                   # Run all tests
npm run test:no-browser    # Tests without the Playwright browser suites
npm run lint               # Lint
npm run typecheck          # Type check
npm run dev                # Worker on :8787 + web app on :5173
npm run graph              # Visualize the project graph
```

You can also target a single package:

```bash
npx nx build @livevariant/server
npx nx test @livevariant/sdk
```

CI runs build, test, lint, and typecheck across all projects, so make sure they pass locally before opening a pull request:

```bash
npx nx run-many -t build test lint typecheck
```

## Testing

Tests run with [Vitest](https://vitest.dev). Most packages have plain Node suites; the SDK, web app, and react package also have browser suites (`*.browser.spec.*`) that run in real Chromium via Playwright.

Pull requests that change behavior should include or update tests covering that behavior. User-facing flows should have a browser test asserting what actually renders, not just the HTTP responses.

## Pull requests

- Keep them focused: one logical change per PR.
- Make sure CI passes (build, tests, lint, typecheck).
- Describe what the change does and why; link related issues.

The deep technical reference lives in [CLAUDE.md](CLAUDE.md); the design system in [DESIGN.md](DESIGN.md).
