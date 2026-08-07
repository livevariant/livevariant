#!/usr/bin/env node
/**
 * Generates every icon and logo artifact from the two hand-drawn sources
 * in design-assets/ and nothing else:
 *
 *   design-assets/livevariant-icon-light.svg   the canonical mark (DEFAULT:
 *                                              anywhere only one icon fits,
 *                                              the light one is it)
 *   design-assets/livevariant-icon-dark.svg    its dark-mode counterpart
 *
 * Output:
 *   design-assets/generated/   committed renders (PNG with alpha) and the
 *                              derived SVGs; the single source that other
 *                              generators and the README copy/reference
 *   apps/web/public/           favicons, apple-touch, and the header logos
 *
 * Derivations are pure text transforms on the source SVGs: the adaptive
 * favicon swaps literal colors for CSS variables with a prefers-color-scheme
 * override (light stays the no-media-query fallback), and the bare logos
 * drop the background tile and tighten the viewBox to the glyph.
 *
 * PNG rendering runs the SVGs through Playwright's Chromium with a
 * transparent page, so the rounded tile corners and the bare logos keep
 * real alpha. Rendering is NOT byte-deterministic across Chromium builds,
 * which is why these outputs are committed and this script is run by hand
 * (npm run generate:icons) rather than in the CI drift check; the drift-
 * checked generate step only byte-copies from design-assets/generated/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "design-assets");
const out = path.join(src, "generated");
const webPublic = path.join(root, "apps", "web", "public");

const LIGHT = fs.readFileSync(
  path.join(src, "livevariant-icon-light.svg"),
  "utf8"
);
const DARK = fs.readFileSync(
  path.join(src, "livevariant-icon-dark.svg"),
  "utf8"
);

const TILE_LIGHT = "#F2EDE3";
const INK = "#201C17";

/**
 * One favicon that follows the OS theme, with the LIGHT design as the
 * literal fallback for anything that ignores the embedded media query:
 * same rule as everywhere else, one slot means the light icon.
 */
function adaptiveFavicon(lightSvg) {
  const style =
    `<style>` +
    `:root{--tile:${TILE_LIGHT};--ink:${INK}}` +
    `@media (prefers-color-scheme:dark){:root{--tile:${INK};--ink:${TILE_LIGHT}}}` +
    `</style>`;
  return lightSvg
    .replace(/aria-label="[^"]*"/, 'aria-label="LiveVariant"')
    .replace(">", `>${style}`)
    .replaceAll(`"${TILE_LIGHT}"`, `"var(--tile, ${TILE_LIGHT})"`)
    .replaceAll(`"${INK}"`, `"var(--ink, ${INK})"`);
}

/**
 * The bare mark: background tile stripped, viewBox tightened to the
 * glyph (levers span x 208..816, y 236..820 including round caps) with
 * a little air so nothing renders clipped.
 */
function bareLogo(svg) {
  return svg
    .replace(/<rect width="1024"[^/]*\/>\s*/, "")
    .replace(
      /viewBox="0 0 1024 1024"/,
      'viewBox="196 224 632 608" width="632" height="608"'
    )
    .replace(/width="1024" height="1024" /, "");
}

async function renderPng(page, svg, width, height, file) {
  const sized = svg
    .replace(/width="\d+"/, `width="${width}"`)
    .replace(/height="\d+"/, `height="${height}"`);
  await page.setViewportSize({ width, height });
  await page.setContent(`<style>*{margin:0;padding:0}</style>${sized}`, {
    waitUntil: "load"
  });
  await page.screenshot({
    path: file,
    omitBackground: true,
    clip: { x: 0, y: 0, width, height }
  });
  console.log(`  ${path.relative(root, file)} (${width}x${height})`);
}

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(webPublic, { recursive: true });

const faviconSvg = adaptiveFavicon(LIGHT);
const logoLight = bareLogo(LIGHT);
const logoDark = bareLogo(DARK);

const svgs = {
  "icon.svg": faviconSvg,
  "logo-light.svg": logoLight,
  "logo-dark.svg": logoDark
};
for (const [name, content] of Object.entries(svgs)) {
  fs.writeFileSync(path.join(out, name), content);
  console.log(`  ${path.relative(root, path.join(out, name))}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();

// Tile PNGs, alpha outside the rounded corners. Light is the default
// set; dark only where a surface explicitly asks for a dark variant.
for (const size of [16, 32, 180, 192, 512]) {
  await renderPng(page, LIGHT, size, size, path.join(out, `icon-${size}.png`));
}
await renderPng(page, DARK, 512, 512, path.join(out, "icon-512-dark.png"));

// Bare logos at a generous raster size; ratio comes from the tightened
// viewBox (632x608).
const logoHeight = Math.round((512 * 608) / 632);
await renderPng(
  page,
  logoLight,
  512,
  logoHeight,
  path.join(out, "logo-light.png")
);
await renderPng(
  page,
  logoDark,
  512,
  logoHeight,
  path.join(out, "logo-dark.png")
);

await browser.close();

// The web app's copies: favicon set plus the header logos.
const webCopies = {
  "icon.svg": "icon.svg",
  "icon-32.png": "icon-32.png",
  "icon-192.png": "icon-192.png",
  "icon-512.png": "icon-512.png",
  "icon-512-dark.png": "icon-512-dark.png",
  "icon-180.png": "apple-touch-icon.png",
  "logo-light.svg": "logo-light.svg",
  "logo-dark.svg": "logo-dark.svg"
};
for (const [from, to] of Object.entries(webCopies)) {
  fs.copyFileSync(path.join(out, from), path.join(webPublic, to));
  console.log(`  apps/web/public/${to}`);
}

console.log("icons generated");
