import type { TestConfig } from "@livevariant/core";

/**
 * Manage page: a static shell served WITHOUT authentication (it contains
 * nothing beyond what the public config already exposes). The stats secret
 * travels in the URL FRAGMENT (/manage/<cfg>#<secret>): fragments never
 * leave the browser, so the secret stays out of server and proxy logs.
 * The inline script reads location.hash and fetches /stats with a Bearer
 * header. The richer dashboard (React + shadcn) comes with the hosted
 * app later; this page must work on any self-host with zero dependencies.
 */
export function renderManagePage(config: TestConfig, encoded: string): string {
  const armCount = config.arms.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(config.name ?? "LiveVariant test")}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #ddd; }
  code { background: #f4f4f4; padding: .1rem .3rem; border-radius: 3px; font-size: .85em; word-break: break-all; }
  .muted { color: #666; font-size: .9em; }
  .error { color: #b00020; }
</style>
</head>
<body>
<h1>${escapeHtml(config.name ?? "LiveVariant test")}</h1>
<p class="muted" id="meta">loading…</p>
<table>
<thead><tr><th>Arm</th><th>Pulls</th><th>Conversions</th><th>Rate</th><th>Reward</th></tr></thead>
<tbody id="arms"><tr><td colspan="5" class="muted">loading…</td></tr></tbody>
</table>
<h2>URLs</h2>
<p class="muted">Serve (email/link): <code id="u-serve"></code></p>
<p class="muted">Click: <code id="u-click"></code></p>
<p class="muted">Conversion pixel: <code id="u-pixel"></code></p>
<p class="muted">Add <code>?id=&lt;recipient-id&gt;</code> for sticky assignment and
<code>c_&lt;dim&gt;=&lt;value&gt;</code> params for context. Editing the config produces a
new test. This page's <code>#fragment</code> is your stats secret: it never
reaches any server log, but anyone with the full URL can read your stats,
so share it deliberately.</p>
<script>
(function () {
  var cfg = ${JSON.stringify(encoded)};
  var armCount = ${armCount};
  for (var pair of [["u-serve", "/s/"], ["u-click", "/c/"], ["u-pixel", "/px/"]]) {
    document.getElementById(pair[0]).textContent = location.origin + pair[1] + cfg;
  }
  var secret = location.hash.slice(1);
  var meta = document.getElementById("meta");
  var tbody = document.getElementById("arms");
  function fail(message) {
    meta.textContent = "";
    meta.className = "error";
    meta.textContent = message;
    tbody.innerHTML = "";
  }
  if (!secret) {
    fail("No stats secret: open this page as /manage/<config>#<secret>.");
    return;
  }
  fetch(location.pathname.replace("/manage/", "/stats/"), {
    headers: { authorization: "Bearer " + secret }
  })
    .then(function (res) {
      if (res.status === 401) throw new Error("Wrong stats secret in the #fragment.");
      if (!res.ok) throw new Error("Stats request failed (" + res.status + ").");
      return res.json();
    })
    .then(function (stats) {
      meta.textContent =
        "algorithm: " + stats.alg +
        " · assignments: " + stats.totalAssignments +
        " · context buckets: " + Object.keys(stats.buckets).length;
      tbody.innerHTML = "";
      for (var i = 0; i < armCount; i++) {
        var arm = stats.arms[i];
        var tr = document.createElement("tr");
        [
          arm.name || "arm " + i,
          String(arm.pulls),
          String(arm.conversions),
          arm.conversionRate === null ? "–" : (arm.conversionRate * 100).toFixed(1) + "%",
          String(arm.rewardTotal)
        ].forEach(function (text) {
          var td = document.createElement("td");
          td.textContent = text;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
    })
    .catch(function (err) {
      fail(err.message);
    });
})();
</script>
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
