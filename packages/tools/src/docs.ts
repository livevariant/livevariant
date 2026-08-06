import { TOOLS } from "./tools.js";

/**
 * THE single source of truth for everything LiveVariant tells an LLM
 * about itself. Three renderers, one body of content:
 *
 *   - renderSkillMd(apiUrl): the full agent skill, written by
 *     `npm run generate` into skills/ and the plugin bundles, and
 *     served live by every deployment at /skills/livevariant/SKILL.md;
 *   - renderLlmsTxt(origin): the site guidance an agent finds from
 *     the <link rel="llms-txt"> on the dashboard;
 *   - renderMcpInstructions(): the overview MCP clients receive at
 *     initialize.
 *
 * Tool names and summaries come from the registry next door, so a tool
 * change flows into every surface with no second place to edit. Both
 * render functions take the deployment's own URL, so a self-hosted
 * deployment describes ITSELF, never livevariant.com.
 */

const ONE_LINER =
  "Adaptive A/B testing where the whole test lives in a URL: traffic " +
  "shifts toward the winner while the test runs, several elements are " +
  "optimized as one combination, and no account is needed to create one.";

function toolsTable(): string {
  const rows = TOOLS.map(tool => [`\`${tool.name}\``, tool.summary]);
  const headers = ["Tool", "What it does"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map(w => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line)
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Content sections. Markdown, authored here and nowhere else.        */

const IDENTITY_SECTION = `## The one thing to understand first

**A test is its config.** There is no account, no dashboard record, no test id
to look up. The whole configuration is encoded into the test's own URLs, and
the test's identity is a hash of that configuration.

Two consequences that will bite you if you skip them:

1. **Editing a variant creates a different test.** Same URL shape, new
   identity, empty history. That is usually right per campaign, but say it out
   loud before anyone edits a live test's variants.
2. **The stats secret is shown exactly once**, by \`build_test\`. Only its hash
   goes into the config, so nobody can recover it afterwards, including this
   service. Hand it to whoever will read the results, immediately. A test
   built without one runs fine and its results can never be read by anyone.`;

const SHAPES_SECTION = `## The three shapes of a test

Every shape compiles to the same config and runs the same adaptive model; the
shape decides which variant fields you fill and which URLs you hand out.

| Shape               | Variant fields   | Deliverable                                                                  |
| ------------------- | ---------------- | ---------------------------------------------------------------------------- |
| **Email / image**   | \`image\` (+ optional \`url\` click destination) | The \`serveNoAutoContext\` URL in an \`<img>\`, the \`clickNoAutoContext\` URL around it, the pixel for conversions |
| **Page redirect**   | \`url\` per variant | ONE serve URL that 302s each visitor to their sticky page; ideal for ads, bio links, QR codes |
| **Website content** | \`text\` / \`html\` / \`md\` | The encoded config, served on the page through the SDK or the tag (see "Running a test on a website") |

Mixing fields is allowed (a variant with both \`image\` and \`url\` serves the
image and clicks through to the url), but keep one shape per test unless you
know why you are mixing.`;

const ELEMENTS_SECTION = `## Testing several elements at once

\`build_test\` takes either \`variants\` (one element) or \`slots\` (several, e.g.
a hero image AND a call-to-action). With slots the test optimizes the
COMBINATION: one model learns how the elements interact, which two separate
tests structurally cannot see, and stats report both exact per-combination
outcomes and per-slot rollups. Each redirect link then says which element it
serves with \`?slot=\`; all of a recipient's links share one sticky
whole-combination assignment. Prefer two slots over bundling two changes into
one variant: a bundled win never tells you which half worked.`;

const PARAMS_SECTION = `## Every config parameter, and when to use it

| Parameter | In identity? | What it does |
| --------- | ------------ | ------------ |
| \`slots\` / \`variants\` | yes | The test itself: elements and their variants. \`variants\` is shorthand for a single \`main\` slot. |
| \`variant.name\` | yes | Label shown in stats. Name after the hypothesis (\`warm-scene\`), not \`v2\`. |
| \`variant.url\` | yes | Redirect destination (redirect shape) or click-through (email shape). |
| \`variant.image\` | yes | Image served for this variant; upload via \`upload_image\` or any public URL. |
| \`variant.text/html/md\` | yes | Inline content for SDK-served website tests. |
| \`variant.redirectUrl\` | yes | Per-variant CLICK destination, wins over the config-level one. |
| \`name\` | yes | Human label for the whole test. |
| \`ctx.dims\` | yes | Audience dimensions the model learns separate winners for. \`{key}\` = caller-supplied value (hashed in the browser); \`{key, from}\` = filled automatically from the request. \`from\` may be: country, continent, region, city, timezone, device, language, organization, utm_source, utm_medium, utm_campaign, utm_content, utm_term. The utm ones survive email proxies; the network ones do not (see the email section). |
| \`region\` | yes | Where the test's counters and model live. \`eu\` is a hard guarantee (data never leaves the EU); weur/eeur/wnam/enam/sam/apac/oc/afr/me are placement preferences. Unset = wherever the first request lands, which in email is often a mail provider's datacenter, so set it for email tests. Changing it later = a new test. |
| \`redirectUrl\` | yes | Fallback click destination when neither \`?to=\` nor a per-variant redirectUrl says where to go. The click link REFUSES rather than 404s when all three are missing. |
| \`rewardEvents\` | no* | GA4 event names the tag/SDK count as conversions (defaults: purchase, sign_up, generate_lead, conversion). |
| \`variantParam\` | yes | Stamps the served variant's name into this query parameter on the redirect, so the destination's own analytics can segment by variant with zero integration. |
| \`forwardParams\` | yes | Default true: unrecognized query params (utm_*, gclid...) are forwarded onto the destination. \`false\` turns that off. |
| \`decorateRedirects\` | no | Default true: redirects carry the identity handoff (_lvt/_lvid/_lvvar) to the destination so its tag can keep attribution and consistency. |
| \`priors\` | **no** | Warm-start beliefs via \`generate_priors\`. Deliberately OUTSIDE the identity hash: add or tune priors mid-test without losing history. |
| \`statsKeyHash\` | yes | The sha256 of the stats secret. Safe in public links; the secret itself never appears in any URL except the manage link's #fragment. |

*rewardEvents rides in the config but does not change serving, only what the
page-side tracker listens for.`;

const URL_FORM_SECTION = `## Creating a test with nothing but a URL

Every test can be spelled as plain query parameters instead of the base64
config: both parse to the same config and hash to the same testId. This is the
zero-tooling tier: no MCP, no SDK, no account, just a URL you compose.

\`\`\`
{origin}/s?v=https://cdn.you.com/hero-a.jpg&v=https://cdn.you.com/hero-b.jpg
       &vn=warm&vn=cool&n=March%20hero&kh=<statsKeyHash>&id={{recipient_id}}&auto=0
\`\`\`

Config parameters (these define the test, and therefore its identity):

- \`v\` (repeated, 2+): variant target URLs, first is the control;
- \`vn\` (repeated, optional): variant names, positional against the \`v\` order;
- \`s\`: opens a slot for multi-element tests: \`s=hero&v=..&v=..&s=cta&v=..&v=..\`
  (then each link adds \`&slot=hero\` or \`&slot=cta\` to say which element it
  renders; all links share one sticky combination per id);
- \`n\`: test name; \`kh\`: the stats-secret HASH (never the secret);
- \`ctx\`: audience dims, e.g. \`ctx=country:country,persona\` (\`key:from\` fills
  automatically, bare \`key\` expects a \`c_<key>=\` value on the link);
- \`r\`: fallback click destination; \`stamp\`: write the served variant name
  into this parameter on the destination; \`fw=0\`: stop forwarding unknown
  params.

Runtime parameters (consumed per request, never part of identity): \`id\` (the
visitor/recipient identifier, hashed per test server-side), \`auto=0\` (drop
network-derived context; always use on email links), \`to\` (explicit click
destination), \`slot\`.

Why this matters for email templates: wire the fixed parts (\`kh\`, \`auto=0\`,
\`id={{merge_tag}}\`) into an ESP template once, and campaign managers fill in
nothing but variant URLs through ordinary template fields. Because variant
URLs are inside the identity hash, **each campaign automatically becomes its
own fresh test**, while the one shared \`kh\` means one stats secret reads all
of them. \`build_test\` returns this spelling ready-made as \`emailTemplate\`.
A malformed parameter link degrades to serving the first valid variant URL
rather than showing an error to a full recipient list.`;

const FLOW_SECTION = `## Working flow

1. \`variant_brief\` for the constraints that apply to the channel and format.
2. Draft the variants yourself against that brief.
3. \`build_test\` to get the URLs and the stats secret. Store the secret.
4. \`generate_priors\`, optionally, to warm-start from what you expect.
5. \`get_stats\` to read results.

\`inspect_test\` answers "what does this link do?" for any LiveVariant URL, and
lints it for the mistakes that only surface once a campaign has gone out.`;

const RESULTS_SECTION = `## Reading results honestly

Never call a winner by comparing conversion rates. A variant ahead 2/10 to
1/10 looks twice as good and is close to a coin flip; this is the single most
common way an A/B test gets called wrong.

\`get_stats\` returns, for each combination, the probability it is genuinely
best, and the expected cost of stopping now and keeping the current leader.
Use those. It also refuses to call a test that has barely run, however
lopsided the raw numbers look.

There is rarely urgency in acting on a result, because the model has already
been shifting traffic toward the leader the entire time.`;

const EMAIL_SECTION = `## Running a test in email

Email is where this is most useful and most easily got wrong.

- **Give every recipient a distinct \`?id=\`** using your platform's merge tag.
  Without it every recipient shares one URL, the provider caches a single
  fetch, everyone sees the same variant, and the campaign records one
  assignment.
- **Use the \`auto=0\` links.** Anything reaching an inbox is fetched by the
  mail provider or a link scanner, not the reader, so location and device
  derived from the connection describe a datacenter. \`build_test\` returns
  these ready-made.
- **\`utm_*\` context still works.** Campaign tags are read off the link the
  sender wrote, so a proxy relays them intact. They are the reliable way to
  learn a different winner per traffic source.
- **Clicks and on-site conversions are the trustworthy signals.** Raw opens
  are not, in any email tool.

\`build_test\` also returns an \`emailTemplate\`: the query-parameter spelling of
the same test (see "Creating a test with nothing but a URL"), for wiring into
an email platform's template once so campaign managers only fill in the
variant fields.`;

const WEBSITE_SECTION = `## Running a test on a website

You are often the same agent that edits the site's code, so run the whole
loop yourself instead of handing snippets to a human:

1. \`build_test\` with \`text\` (or \`html\`/\`md\`) variants; keep the returned
   \`config\` (the encoded string).
2. Put the tag in \`<head>\` once:
   \`<script defer src="{origin}/sdk.js" data-publishable-key="pk_..."></script>\`
   The tag sets the page config (\`window.livevariant = { config, sdk }\`),
   auto-tracks conversions from existing GA events, and upgrades any
   LiveVariant image/click URLs on the page with the visitor's identity. The
   publishable key is optional and PUBLIC; with one whose account verified
   this domain, the test registers under that account automatically.
3. Serve the test where the content lives, passing the ENCODED config so the
   page serves exactly the test you built (identity, region and stats key
   included), never a lookalike rebuilt from slots:

   \`\`\`js
   const test = await window.livevariant.sdk.createTest("<encoded>");
   document.querySelector("#headline").textContent = test.slots.headline.text;
   \`\`\`

   Bundled apps use \`npm i @livevariant/sdk\` and the same call
   (\`createTest("<encoded>")\`); with the tag on the page no options are
   needed, and without it pass \`{ serverUrl }\`. \`createTest\` waits briefly
   for a tag-manager-loaded tag on its own, so load order is not your
   problem.
4. Image tests on a page: prefer
   \`<img data-lv-src="{origin}/s/<config>">\` (the tag fills src with the
   identity attached: one fetch, no flicker); a bare \`src\` also works and is
   upgraded after its first anonymous fetch.
5. Conversions: GA events matching \`rewardEvents\` count automatically; call
   \`test.trackConversion()\` (or \`window.livevariant.sdk.trackConversion()\`)
   at conversion points you wire yourself.`;

const IMAGES_SECTION = `## No image variants yet? Make them

Missing creative is not a blocker: \`upload_image\` stores an image on the
deployment and returns a protected URL to use as a variant (it only serves
inside the test's flow, so hotlinking is a non-issue). Get pixels however
your environment allows, in this order:

1. **Your own image generation tool**, if you have one: generate the
   variations, then \`upload_image\` each.
2. **Author HTML or SVG and render it**: you are good at exact typography,
   layout and brand colors in markup; screenshot it at fixed dimensions with
   your browser tool or Playwright (or convert with ImageMagick/rsvg if
   available), then \`upload_image\` the PNGs.
3. **Ask the human for assets**, as the last resort rather than the default.

Discipline that keeps generated variants a valid experiment: every variant of
one element must share EXACT pixel dimensions (they occupy the same slot);
change one visual hypothesis per test (scene OR headline treatment, not
both); name variants after the hypothesis (\`warm-scene\`, \`cool-scene\`) so
stats read meaningfully. For email heroes, roughly 1200x600 and modest file
size travel best.`;

const OWNERSHIP_SECTION = `## Saving a test to an account

Creating needs no account, ever. When a human wants a test in their
dashboard ("My tests"), do NOT collect credentials or keys: hand them the
\`manage\` URL from \`build_test\` and tell them that opening it (signed in)
lets them save the test into their organization with one click. The manage
URL carries the stats secret in its #fragment, so treat it like the secret
it contains.

Publishable keys (\`pk_...\`) are separate and PUBLIC: they only make
website-served tests register to the key's account automatically when the
page's domain is verified there. It is safe for a user to paste one into
chat for you to put in a tag snippet; it grants nothing beyond that
registration.`;

function restSection(apiUrl: string): string {
  return `## If you cannot install the MCP server

Every tool is also a plain HTTP endpoint with the same name, same input and
same output: \`POST ${apiUrl}/api/v1/<tool-name-with-dashes>\`, JSON body.
Interactive documentation is at ${apiUrl}/docs and the OpenAPI document at
${apiUrl}/openapi.json. There are no API keys; a test's config and its stats
secret travel in the request body.`;
}

const LIMITS_SECTION = `## Limits worth knowing

- Variants must be publicly reachable URLs, or short inline text/HTML.
  Deployments with asset hosting accept images via \`upload_image\`; anything
  else you host yourself.
- A test needs at least two combinations (512 at most), and every variant of
  a redirect-served slot must have a url or image: one inline-only variant
  makes that slot's serve URL fail for everyone, not just for that variant.
- Priors sit outside the identity hash, so they can be added or changed
  mid-test without losing history. Variants, slots, context dimensions and
  the stats key cannot.`;

/* ------------------------------------------------------------------ */
/* Renderers.                                                          */

export function renderSkillMd(apiUrl = "https://livevariant.com"): string {
  const origin = apiUrl.replace(/\/+$/, "");
  const body = [
    `# LiveVariant`,
    ``,
    `LiveVariant serves A/B test variants with one adaptive model (joint linear`,
    `Thompson sampling). Traffic shifts toward whatever is winning **while the test`,
    `runs**, so a losing variant stops costing money long before the test is`,
    `"significant". There is no algorithm to pick and nothing to tune: the model is`,
    `sized from the test's own shape, for every test.`,
    ``,
    IDENTITY_SECTION,
    ``,
    `## Tools`,
    ``,
    toolsTable(),
    ``,
    SHAPES_SECTION,
    ``,
    ELEMENTS_SECTION,
    ``,
    PARAMS_SECTION,
    ``,
    URL_FORM_SECTION.replaceAll("{origin}", origin),
    ``,
    FLOW_SECTION,
    ``,
    RESULTS_SECTION,
    ``,
    EMAIL_SECTION,
    ``,
    WEBSITE_SECTION.replaceAll("{origin}", origin),
    ``,
    IMAGES_SECTION,
    ``,
    OWNERSHIP_SECTION,
    ``,
    restSection(origin),
    ``,
    LIMITS_SECTION,
    ``
  ].join("\n");
  const frontmatter = [
    `---`,
    `name: livevariant`,
    `description: Run A/B tests that pick their own winner. Build a test from variants of one element or several at once (hero plus CTA), get URLs for email or web, and read results with real win probabilities instead of eyeballed conversion rates. Use when someone wants to test headlines, images, landing pages or email creative, or asks which variant is winning.`,
    `license: AGPL-3.0`,
    `---`,
    ``
  ].join("\n");
  return frontmatter + body;
}

export function renderLlmsTxt(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return `# LiveVariant

> ${ONE_LINER}

You (an AI agent) can create a working A/B test here with ZERO signup, keys
or setup. Authority travels in arguments: a test's config and stats secret
are all there is.

## Start here

- [Agent skill (SKILL.md)](${base}/skills/livevariant/SKILL.md): the full
  recipe document. Read it before building anything.
- [MCP server](${base}/mcp): streamable HTTP, no auth. Or install the skill:
  \`npx skills add livevariant/livevariant\`.
- [OpenAPI](${base}/openapi.json) and [interactive docs](${base}/docs): every
  tool as \`POST ${base}/api/v1/<tool-name>\`, plain JSON.
- Source (AGPL, self-hostable): https://github.com/livevariant/livevariant

## The capability ladder

1. **Just URLs**: compose a test from documented query parameters
   (\`${base}/s?v=<url-a>&v=<url-b>&id={{recipient_id}}&auto=0\`); each distinct
   parameter set IS its own test. The skill documents the full grammar.
2. **Tools**: build_test / inspect_test / generate_priors / get_stats /
   upload_image / variant_brief / list_tests via MCP or REST.
3. **On-page**: the tag (\`${base}/sdk.js\`) plus
   \`window.livevariant.sdk.createTest("<encoded>")\` serves website tests you
   build, and \`upload_image\` lets you create image variants yourself.

## Ownership

Creating requires no account. To save a test into a human's dashboard, hand
them its manage URL: opening it signed-in claims the test in one click. Never
collect credentials.

## Terms

Hosted service terms: ${base}/terms · privacy: ${base}/privacy
`;
}

export function renderMcpInstructions(): string {
  return (
    "LiveVariant runs A/B tests with multi-armed bandits, so traffic " +
    "shifts toward the winner while the test runs instead of waiting for " +
    "a frozen split to reach significance.\n\n" +
    "There are no accounts. A test IS its config, encoded into its own " +
    "URLs, and its identity is a hash of that config, so editing a " +
    "variant produces a different test with its own empty history. " +
    "build_test returns a stats secret exactly once; without it a test's " +
    "results can never be read by anyone.\n\n" +
    "Three shapes, one model: email/image tests (image variants, serve " +
    "URL in an <img>), page redirect tests (url variants, one link that " +
    "302s), and website tests (text/html variants served on-page via the " +
    "tag or SDK with the ENCODED config). Multi-element tests use slots; " +
    "one model optimizes the combination.\n\n" +
    "Typical flow: variant_brief to learn the constraints, draft the " +
    "variants yourself, build_test for the URLs, optionally " +
    "generate_priors to warm-start from what you expect, then get_stats " +
    "to read results. Trust get_stats's win probabilities over comparing " +
    "conversion rates by eye.\n\n" +
    "Missing image variants are not a blocker: author HTML/SVG, render " +
    "to fixed-size PNGs (browser screenshot or your image tool), and " +
    "upload_image each; all variants of one element must share exact " +
    "dimensions.\n\n" +
    "To save a test into a human's account, hand them build_test's " +
    "manage URL (opening it signed-in claims the test); never collect " +
    "credentials. The full recipes live in the livevariant skill, also " +
    "served at /skills/livevariant/SKILL.md on every deployment."
  );
}
