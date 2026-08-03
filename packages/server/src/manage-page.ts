import {
  configToParams,
  slotEntries,
  variantName,
  type TestConfig
} from "@livevariant/core";

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
  const slots = slotEntries(config).map(([key, variants]) => ({
    key,
    variants: variants.map((v, i) => variantName(v, i))
  }));
  const multiSlot = slots.length > 1;
  // The same test spelled as plain query parameters, when expressible:
  // the readable form of the URL, shown behind a toggle.
  const plainQuery = configToParams(config)?.toString() ?? null;
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
  h2 { margin-top: 2rem; font-size: 1.1em; }
  .muted { color: #666; font-size: .9em; }
  .error { color: #b00020; }
  button.link { background: none; border: none; color: #0645ad; cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
</style>
</head>
<body>
<h1>${escapeHtml(config.name ?? "LiveVariant test")}</h1>
<p class="muted" id="meta">loading…</p>
<div id="tables"></div>
<h2>URLs</h2>
<p class="muted">
  Serve (email/link): <code id="u-serve"></code><br>
  Click: <code id="u-click"></code><br>
  Conversion pixel: <code id="u-pixel"></code>
  ${
    plainQuery
      ? `<br><button class="link" id="toggle-plain" type="button">show as plain URL parameters</button>`
      : ""
  }
</p>
<p class="muted">Add <code>?id=&lt;recipient-id&gt;</code> for sticky assignment${
    multiSlot
      ? `, <code>&amp;slot=&lt;name&gt;</code> to pick which element a link serves,`
      : " and"
  }
<code>c_&lt;dim&gt;=&lt;value&gt;</code> params for context. Editing the config produces a
new test. This page's <code>#fragment</code> is your stats secret: it never
reaches any server log, but anyone with the full URL can read your stats,
so share it deliberately.</p>
<script>
(function () {
  var cfg = ${JSON.stringify(encoded)};
  var slots = ${JSON.stringify(slots)};
  var multiSlot = ${JSON.stringify(multiSlot)};
  var plainQuery = ${JSON.stringify(plainQuery)};
  var plain = false;
  function renderUrls() {
    for (var pair of [["u-serve", "/s"], ["u-click", "/c"], ["u-pixel", "/px"]]) {
      var el = document.getElementById(pair[0]);
      el.textContent =
        plain && plainQuery && pair[0] !== "u-pixel"
          ? location.origin + pair[1] + "?" + plainQuery
          : location.origin + pair[1] + "/" + cfg;
    }
  }
  renderUrls();
  var toggle = document.getElementById("toggle-plain");
  if (toggle) {
    toggle.addEventListener("click", function () {
      plain = !plain;
      toggle.textContent = plain
        ? "show as encoded config"
        : "show as plain URL parameters";
      renderUrls();
    });
  }
  var secret = location.hash.slice(1);
  var meta = document.getElementById("meta");
  var tables = document.getElementById("tables");
  function fail(message) {
    meta.className = "error";
    meta.textContent = message;
  }
  function table(caption, rows) {
    var t = document.createElement("table");
    if (caption) {
      var cap = document.createElement("caption");
      cap.style.textAlign = "left";
      cap.style.fontWeight = "600";
      cap.textContent = caption;
      t.appendChild(cap);
    }
    var head = document.createElement("tr");
    for (var h of ["Variant", "Pulls", "Conversions", "Rate"]) {
      var th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    t.appendChild(head);
    for (var row of rows) {
      var tr = document.createElement("tr");
      for (var text of row) {
        var td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    return t;
  }
  function rate(value) {
    return value === null || value === undefined
      ? "–"
      : (value * 100).toFixed(1) + "%";
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
        "assignments: " + stats.totalAssignments +
        (multiSlot ? " · combinations: " + stats.combinations.length : "") +
        " · context buckets: " + Object.keys(stats.buckets).length;
      tables.innerHTML = "";
      for (var slot of slots) {
        var rows = (stats.slots[slot.key] || []).map(function (v) {
          return [v.name, String(v.pulls), String(v.conversions), rate(v.conversionRate)];
        });
        tables.appendChild(table(multiSlot ? "Slot: " + slot.key : "", rows));
      }
      if (multiSlot) {
        var combos = stats.combinations
          .slice()
          .sort(function (a, b) { return b.pulls - a.pulls; })
          .map(function (combo) {
            return [
              combo.choice.join(" + "),
              String(combo.pulls),
              String(combo.conversions),
              rate(combo.conversionRate)
            ];
          });
        tables.appendChild(table("Combinations", combos));
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
