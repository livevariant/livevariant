/**
 * The "Redirecting you to…" screen, served instead of a 302 when a
 * navigation is headed for a destination this deployment has not
 * verified. Zero dependencies and inline styles, because it renders on
 * the serving domain's hot path and must work on any self-host.
 *
 * The rules around WHEN this renders live in app.ts; this module only
 * draws it. Two invariants it does own: the destination host is named
 * in plain sight, and no referrer ever reaches the destination from
 * this page (the URL being left behind contains the full test config).
 */

export interface InterstitialInput {
  /** The fully decorated destination the visitor continues to. */
  continueUrl: string;
  /** Hostname shown to the visitor, extracted by the caller. */
  destinationHost: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderInterstitialPage(input: InterstitialInput): string {
  const host = escapeHtml(input.destinationHost);
  const href = escapeHtml(input.continueUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Redirecting you to ${host}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.55 system-ui, sans-serif;
    background: #f6f1e7; color: #1a1f1b;
    display: grid; place-items: center;
    min-height: 100dvh; margin: 0; padding: 1.5rem;
  }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 .35rem; }
  .host { font-family: ui-monospace, monospace; word-break: break-all; }
  a.continue {
    display: inline-block; margin: 1.25rem 0 0; padding: .7rem 1.4rem;
    border-radius: .5rem; text-decoration: none; font-weight: 600;
    background: #1a1f1b; color: #f6f1e7;
  }
  p.notice { font-size: .85rem; color: #5c635c; margin-top: 1.5rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #f5f2ec; }
    a.continue { background: #f5f2ec; color: #0a0a0a; }
    p.notice { color: #8a8f8a; }
  }
</style>
</head>
<body>
<main>
  <h1>Redirecting you to</h1>
  <p class="host">${host}</p>
  <a class="continue" rel="noreferrer" href="${href}">Continue to ${host}</a>
  <p class="notice">You are seeing this screen because ${host} has not
  been verified by this link's creator yet. Verified destinations
  redirect immediately.</p>
</main>
</body>
</html>`;
}
