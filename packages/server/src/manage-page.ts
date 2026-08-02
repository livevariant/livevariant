import type { TestConfig } from "@livevariant/core";
import type { TestStats } from "./service.js";

/**
 * Minimal server-rendered manage page: stats at the creator's manage URL
 * with zero client dependencies. The richer dashboard (React + shadcn)
 * lives in the hosted app later; this page must work on any self-host.
 */
export function renderManagePage(
  config: TestConfig,
  stats: TestStats,
  urls: { serve: string; click: string; pixel: string }
): string {
  const rows = stats.arms
    .map((arm, i) => {
      const rate =
        arm.conversionRate === null
          ? "–"
          : `${(arm.conversionRate * 100).toFixed(1)}%`;
      return `<tr><td>${escapeHtml(arm.name ?? `arm ${i}`)}</td><td>${arm.pulls}</td><td>${arm.conversions}</td><td>${rate}</td><td>${arm.rewardTotal}</td></tr>`;
    })
    .join("");
  const bucketCount = Object.keys(stats.buckets).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(config.name ?? "LiveVariant test")}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #ddd; }
  code { background: #f4f4f4; padding: .1rem .3rem; border-radius: 3px; font-size: .85em; word-break: break-all; }
  .muted { color: #666; font-size: .9em; }
</style>
</head>
<body>
<h1>${escapeHtml(config.name ?? "LiveVariant test")}</h1>
<p class="muted">algorithm: ${stats.alg} · assignments: ${stats.totalAssignments} · context buckets: ${bucketCount}</p>
<table>
<thead><tr><th>Arm</th><th>Pulls</th><th>Conversions</th><th>Rate</th><th>Reward</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>URLs</h2>
<p class="muted">Serve (email/link): <code>${escapeHtml(urls.serve)}</code></p>
<p class="muted">Click: <code>${escapeHtml(urls.click)}</code></p>
<p class="muted">Conversion pixel: <code>${escapeHtml(urls.pixel)}</code></p>
<p class="muted">Add <code>?id=&lt;recipient-id&gt;</code> for sticky assignment and
<code>c_&lt;dim&gt;=&lt;value&gt;</code> params for context. Editing the config produces a
new test; keep this manage URL (it contains your stats secret) private.</p>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
