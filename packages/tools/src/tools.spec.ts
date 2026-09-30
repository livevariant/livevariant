import { describe, expect, it } from "vitest";
import { decodeConfig, hashStatsSecret } from "@livevariant/core";
import {
  TOOLS,
  buildTest,
  uploadImage,
  findTool,
  generatePriors,
  getStats,
  getTestStatus,
  inspectTest,
  variantBrief
} from "./tools.js";
import { ToolInputError, toolPath } from "./types.js";

const A = "https://cdn.example.com/hero-a.jpg";
const B = "https://cdn.example.com/hero-b.jpg";

/** No tool may reach the real network in a test. */
const noFetch: typeof globalThis.fetch = () => {
  throw new Error("unexpected network call");
};
const ctx = { serverUrl: "https://livevariant.link", fetch: noFetch };

async function twoVariantTest() {
  return buildTest.handler({ variants: [{ url: A }, { url: B }] }, ctx);
}

async function segmentedTest() {
  return buildTest.handler(
    {
      variants: [{ url: A }, { url: B }],
      context: [{ key: "color", values: ["blauw", "rood"] }]
    },
    ctx
  );
}

describe("the registry itself", () => {
  it("has unique names and a REST path for each", () => {
    const names = TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(n => /^[a-z][a-z0-9_]*$/.test(n))).toBe(true);
    expect(toolPath("get_stats")).toBe("/api/v1/get-stats");
  });

  it("describes every tool well enough to choose between them", () => {
    // These strings are the entire basis on which an assistant picks a
    // tool, and they are also what the SKILL table renders.
    for (const tool of TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.summary.length).toBeGreaterThan(20);
      expect(tool.description.length).toBeGreaterThan(80);
      expect(findTool(tool.name)).toBe(tool);
    }
  });

  it("only reaches the network where it must", () => {
    expect(getStats.reachesNetwork).toBe(true);
    expect(uploadImage.reachesNetwork).toBe(true);
    // Non-read-only tools: build_test may register a test when given a
    // publishable key, upload_image stores bytes, and register_test writes
    // an ownership record.
    expect(buildTest.reachesNetwork).toBe(false);
    expect(buildTest.readOnly).toBe(false);
    expect(uploadImage.readOnly).toBe(false);
    const registerTest = TOOLS.find(t => t.name === "register_test")!;
    expect(registerTest.reachesNetwork).toBe(true);
    expect(registerTest.readOnly).toBe(false);
    // get_test_status reads the registry over the network but writes
    // nothing.
    const getTestStatus = TOOLS.find(t => t.name === "get_test_status")!;
    expect(getTestStatus.reachesNetwork).toBe(true);
    expect(getTestStatus.readOnly).toBe(true);
    const writers = new Set([
      "build_test",
      "get_stats",
      "get_test_status",
      "upload_image",
      "register_test"
    ]);
    for (const tool of TOOLS.filter(t => !writers.has(t.name))) {
      expect(tool.reachesNetwork).toBe(false);
      expect(tool.readOnly).toBe(true);
    }
  });
});

describe("build_test", () => {
  it("returns a working test with every URL and the secret once", async () => {
    const out = await buildTest.handler(
      { variants: [{ url: A, name: "hero" }, { url: B }], name: "August" },
      ctx
    );
    expect(out.testId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.urls.serve).toBe(`https://livevariant.link/s/${out.config}`);
    expect(out.urls.manage).toContain(`#${out.statsSecret}`);
    expect(out.urls.serveNoAutoContext).toContain("auto=0");

    // The config really is the test: it decodes, and only the HASH of the
    // secret is in it, so the secret cannot be recovered from a URL.
    const decoded = await decodeConfig(out.config);
    expect(decoded.testId).toBe(out.testId);
    expect(decoded.config.slots.main.map(v => v.name)).toEqual(["hero", "v2"]);
    expect(decoded.config.statsKeyHash).toBe(
      await hashStatsSecret(out.statsSecret)
    );
    expect(out.config).not.toContain(out.statsSecret);
  });

  it("builds a multi-slot test that optimizes the combination", async () => {
    const out = await buildTest.handler(
      {
        slots: {
          hero: [
            { url: A, name: "warm" },
            { url: B, name: "cool" }
          ],
          cta: [
            { url: "https://example.com/go", name: "go" },
            { url: "https://example.com/wait", name: "wait" }
          ]
        }
      },
      ctx
    );
    expect(out.combinations).toBe(4);
    // Canonical (sorted) slot order, same as stats will report.
    expect(out.slots.map(s => s.slot)).toEqual(["cta", "hero"]);
    // One template per slot, each naming which element it serves.
    expect(out.emailTemplate.hero.imageSrc).toContain("slot=hero");
    expect(out.emailTemplate.cta.imageSrc).toContain("slot=cta");
    expect(out.emailTemplate.hero.imageSrc).toContain("s=hero");
    // Hypothesis names ride along, so every campaign's stats keep them.
    expect(out.emailTemplate.hero.imageSrc).toContain("vn=warm");
    // ONE slot-less click link shared by every element: the template's
    // destination never depends on which image was clicked.
    expect(out.emailTemplate.hero.linkHref).not.toContain("slot=");
    expect(out.emailTemplate.hero.linkHref).toBe(
      out.emailTemplate.cta.linkHref
    );
    // The bare serve URL 400s for multi-slot tests, so ready per-slot
    // links must be part of the answer.
    expect(out.slotLinks).toEqual({
      hero: {
        serve: `${out.urls.serve}?slot=hero`,
        click: `${out.urls.click}?slot=hero`
      },
      cta: {
        serve: `${out.urls.serve}?slot=cta`,
        click: `${out.urls.click}?slot=cta`
      }
    });
  });

  it("keeps slotLinks absent for single-element tests", async () => {
    const out = await twoVariantTest();
    expect(out.slotLinks).toBeUndefined();
  });

  it("reports destination verification and warns on unverified hosts", async () => {
    const statusCalls: Array<{ encoded: string; statsSecret: string }> = [];
    const out = await buildTest.handler(
      { variants: [{ url: A }, { url: B }] },
      {
        ...ctx,
        accounts: {
          listTests: () => Promise.reject(new Error("not needed")),
          testStatus: async input => {
            statusCalls.push(input);
            return {
              ok: true as const,
              testId: "x".repeat(64),
              claimed: false,
              org: null,
              destinations: [{ host: "cdn.example.com", verified: false }]
            };
          }
        }
      }
    );
    // Status was asked with the freshly minted pair, never a lookalike.
    expect(statusCalls).toEqual([
      { encoded: out.config, statsSecret: out.statsSecret }
    ]);
    expect(out.destinations).toEqual([
      { host: "cdn.example.com", verified: false }
    ]);
    expect(
      out.warnings.some(
        w => w.includes("cdn.example.com") && w.includes("continue screen")
      )
    ).toBe(true);
  });

  it("refuses both spellings at once, and neither", async () => {
    await expect(
      buildTest.handler(
        { variants: [{ url: A }, { url: B }], slots: { x: [{ url: A }] } },
        ctx
      )
    ).rejects.toThrow();
    await expect(buildTest.handler({}, ctx)).rejects.toThrow();
  });

  it("warns when a variant cannot be served by redirect", async () => {
    // The trap: mixing inline and redirect variants makes the serve URL
    // 400 for EVERYONE, not just for that variant. The URLs still come
    // back: the fix is a url on that variant, and the links then work.
    const out = await buildTest.handler(
      { variants: [{ url: A }, { text: "Buy now" }] },
      ctx
    );
    expect(out.warnings.join(" ")).toMatch(/cannot be served by redirect/i);
    expect(out.urls.serve).toBe(`https://livevariant.link/s/${out.config}`);
    expect(out.sdkSnippet).toBeUndefined();
  });

  it("hands a content-only test its SDK snippet instead of serve links", async () => {
    // Inline variants have no redirect target, so /s can never succeed
    // for them: returning that URL in the same shape as a redirect
    // test's was a trap (#64). The SDK is the serving path, so the
    // response carries that install instead, encoded config inlined.
    const out = await buildTest.handler(
      {
        slots: {
          headline: [{ text: "Ship faster" }, { text: "Ship safer" }],
          body: [{ html: "<p>A</p>" }, { html: "<p>B</p>" }]
        },
        publishableKey: "pk_abcdefghijklmnopqrstuvwx"
      },
      ctx
    );
    expect(out.urls.serve).toBeUndefined();
    expect(out.urls.serveNoAutoContext).toBeUndefined();
    expect(out.slotLinks).toBeUndefined();
    expect(out.emailTemplate).toBeUndefined();
    // Click and pixel never look at url/image; manage is always there.
    expect(out.urls.click).toBe(`https://livevariant.link/c/${out.config}`);
    expect(out.urls.pixel).toBe(`https://livevariant.link/px/${out.config}`);
    expect(out.urls.manage).toContain(`#${out.statsSecret}`);
    // Nothing broken is being advertised, so nothing to warn about.
    expect(out.warnings.join(" ")).not.toMatch(/400|cannot be served/i);
    expect(out.sdkSnippet).toContain(
      '<script defer src="https://livevariant.link/sdk.js" ' +
        'data-publishable-key="pk_abcdefghijklmnopqrstuvwx"></script>'
    );
    expect(out.sdkSnippet).toContain(
      `window.livevariant.sdk.createTest("${out.config}")`
    );
    expect(out.sdkSnippet).toContain(
      'document.querySelector("#headline").textContent = test.slots.headline.text;'
    );
    expect(out.sdkSnippet).toContain(
      'document.querySelector("#body").innerHTML = test.slots.body.html;'
    );
  });

  it("places every inline format a mixed slot carries, not just the first", async () => {
    // One variant is text, the other html: the SDK hands back whichever
    // variant it chose, so a snippet that reads `.text` from both would
    // render nothing for the html visitor.
    const out = await buildTest.handler(
      {
        slots: {
          hero: [{ text: "Plain" }, { html: "<em>Rich</em>" }],
          "aside-note": [{ markdown: "*a*" }, { text: "b" }]
        }
      },
      ctx
    );
    const lines = (out.sdkSnippet ?? "").split("\n").map(l => l.trim());
    expect(lines).toContain(
      'if (test.slots.hero.html !== undefined) document.querySelector("#hero").innerHTML = test.slots.hero.html;'
    );
    expect(lines).toContain(
      'else if (test.slots.hero.text !== undefined) document.querySelector("#hero").textContent = test.slots.hero.text;'
    );
    // A slot name that is not an identifier is still addressed, and the
    // markdown branch goes through the renderer the page has to supply.
    expect(lines).toContain(
      'if (test.slots["aside-note"].md !== undefined) document.querySelector("#aside-note").innerHTML = renderMarkdown(test.slots["aside-note"].md);'
    );
    expect(lines).toContain(
      'else if (test.slots["aside-note"].text !== undefined) document.querySelector("#aside-note").textContent = test.slots["aside-note"].text;'
    );
    // The whole thing parses as a script body, so no branch can have
    // swallowed the next slot's line.
    const body = lines.slice(lines.indexOf("") + 1).join("\n");
    expect(() => new Function(`(async () => {${body}})`)).not.toThrow();
    // A uniform slot keeps the one-line form.
    const uniform = await buildTest.handler(
      { variants: [{ text: "A" }, { text: "B" }] },
      ctx
    );
    expect(uniform.sdkSnippet).toContain(
      'document.querySelector("#main").textContent = test.slots.main.text;'
    );
    expect(uniform.sdkSnippet).not.toContain("if (");
    // No markdown anywhere, no renderer to point at.
    expect(uniform.sdkSnippet).not.toContain("renderMarkdown");
  });

  it("places a markdown variant, as its source until the page supplies a renderer", async () => {
    // The SDK hands markdown back unrendered and the page's renderer is
    // not ours to know. A branch that did nothing left the default in
    // place for every markdown visitor, so the placeholder shows the
    // source instead, and the agent points it at the real renderer.
    const out = await buildTest.handler(
      {
        slots: {
          headline: [{ markdown: "# A" }, { markdown: "# B & <C>" }],
          "aside-note": [{ text: "a" }, { markdown: "*b*" }]
        }
      },
      ctx
    );
    const lines = (out.sdkSnippet ?? "").split("\n").map(l => l.trim());
    expect(lines).toContain(
      'document.querySelector("#headline").innerHTML = renderMarkdown(test.slots.headline.md);'
    );
    const body = lines.slice(lines.indexOf("") + 1).join("\n");
    const run = async (slots: Record<string, unknown>) => {
      const els: Record<string, { textContent?: string; innerHTML?: string }> =
        { "#headline": {}, "#aside-note": {} };
      const document = {
        documentElement: { classList: { remove: () => undefined } },
        querySelector: (sel: string) => els[sel]
      };
      const window = {
        livevariant: { sdk: { createTest: async () => ({ slots }) } }
      };
      const fn = new Function(
        "window",
        "document",
        `return (async () => {${body}})();`
      );
      await fn(window, document);
      return els;
    };
    // Both visitors get their variant: the markdown one as escaped
    // source, the text one as text.
    const md = await run({
      headline: { md: "# B & <C>" },
      "aside-note": { md: "*b*" }
    });
    expect(md["#headline"].innerHTML).toBe("# B &amp; &lt;C&gt;");
    expect(md["#aside-note"].innerHTML).toBe("*b*");
    expect(md["#aside-note"].textContent).toBeUndefined();
    const text = await run({
      headline: { md: "# A" },
      "aside-note": { text: "a" }
    });
    expect(text["#aside-note"].textContent).toBe("a");
    expect(text["#aside-note"].innerHTML).toBeUndefined();
  });

  it("cloaks the tested elements until the swap, and never past a failure", async () => {
    // The naive install paints the default, then flips it for every
    // visitor assigned another variant (#84). The snippet hides only
    // the tested selectors, from before first paint until createTest
    // has answered, or failed, or run out of time.
    const out = await buildTest.handler(
      {
        slots: {
          headline: [{ text: "A" }, { text: "B" }],
          "aside-note": [{ html: "<p>a</p>" }, { html: "<p>b</p>" }]
        }
      },
      ctx
    );
    const [head, body] = (out.sdkSnippet ?? "").split("\n\n");
    expect(head).toContain(
      "<style>html.lv-pending #aside-note, html.lv-pending #headline { visibility: hidden; }</style>"
    );
    expect(head).toContain(
      '<script>document.documentElement.classList.add("lv-pending"); ' +
        'setTimeout(function () { document.documentElement.classList.remove("lv-pending"); }, 2000);</script>'
    );
    // Style and inline script precede the tag: the class is on <html>
    // before the SDK, let alone the swap, can run.
    expect(head.indexOf("<style>")).toBeLessThan(head.indexOf("<script>"));
    expect(head.indexOf("<script>")).toBeLessThan(
      head.indexOf("<script defer")
    );

    // Run the body against a stub page, once with createTest resolving
    // and once with it rejecting: the swap lands in the first case, and
    // the cloak comes off in both.
    const run = async (createTest: () => Promise<unknown>) => {
      const classes = new Set(["lv-pending"]);
      const els: Record<string, { textContent?: string; innerHTML?: string }> =
        { "#headline": {}, "#aside-note": {} };
      const document = {
        documentElement: {
          classList: { remove: (c: string) => classes.delete(c) }
        },
        querySelector: (sel: string) => els[sel]
      };
      const window = { livevariant: { sdk: { createTest } } };
      const fn = new Function(
        "window",
        "document",
        `return (async () => {${body}})();`
      );
      const outcome = await fn(window, document).then(
        () => "resolved",
        () => "rejected"
      );
      return { outcome, classes, els };
    };
    const ok = await run(async () => ({
      slots: { headline: { text: "B" }, "aside-note": { html: "<p>b</p>" } }
    }));
    expect(ok.outcome).toBe("resolved");
    expect(ok.els["#headline"].textContent).toBe("B");
    expect(ok.els["#aside-note"].innerHTML).toBe("<p>b</p>");
    expect(ok.classes.has("lv-pending")).toBe(false);
    const failed = await run(async () => {
      throw new Error("offline");
    });
    expect(failed.outcome).toBe("rejected");
    expect(failed.els["#headline"].textContent).toBeUndefined();
    expect(failed.classes.has("lv-pending")).toBe(false);
  });

  it("builds an ESP template from one shared config string", async () => {
    const out = await twoVariantTest();
    const { imageSrc, linkHref } = out.emailTemplate.main;
    expect(imageSrc).toContain("v={{variant_1_url}}");
    expect(imageSrc).toContain("v={{variant_2_url}}");
    expect(imageSrc).toMatch(/kh=[0-9a-f]{64}/);
    // Email defaults to no derived context, which is the honest setting.
    expect(imageSrc).toContain("auto=0");
    // r is identity: it must ride on the image link too, or the click
    // would reward a different test than the one being served.
    expect(imageSrc).toContain("r={{landing_url}}");
    expect(linkHref).toContain("r={{landing_url}}");
    const configOf = (link: string) =>
      new URL(link.replace(/\{\{/g, "X").replace(/\}\}/g, "Y")).search
        .replace(/&(auto|id|slot)=[^&]*/g, "")
        .replace(/\?(auto|id|slot)=[^&]*&?/, "?");
    expect(configOf(linkHref)).toBe(configOf(imageSrc));
  });

  it("returns the template for image variants: the case email exists for", async () => {
    // Image variants with a shared redirectUrl is the canonical email
    // shape (hosted uploads land as `image`), and for a while it was the
    // one shape that came back with no emailTemplate at all (#60).
    const out = await buildTest.handler(
      {
        redirectUrl: "https://example.com/offer",
        variants: [{ image: A }, { image: B }]
      },
      ctx
    );
    const { imageSrc, linkHref } = out.emailTemplate.main;
    expect(imageSrc).toContain("v={{variant_1_url}}");
    expect(imageSrc).toContain(
      `r=${encodeURIComponent("https://example.com/offer")}`
    );
    expect(linkHref).toContain(
      `r=${encodeURIComponent("https://example.com/offer")}`
    );
  });
});

describe("inspect_test", () => {
  it("accepts a bare config, a serve URL and a manage URL alike", async () => {
    const built = await twoVariantTest();
    for (const ref of [
      built.config,
      built.urls.serve,
      `${built.urls.serve}?id=abc`,
      built.urls.manage
    ]) {
      const out = await inspectTest.handler({ test: ref }, ctx);
      expect(out.testId).toBe(built.testId);
    }
  });

  it("accepts the test under the name build_test returned it: config", async () => {
    // The obvious agent move is to feed a response field forward under
    // its own name; that must not cost a failed round-trip (#62).
    const built = await twoVariantTest();
    const out = await inspectTest.handler({ config: built.config }, ctx);
    expect(out.testId).toBe(built.testId);
    // Both names with the same value is redundancy, not a conflict.
    const both = await inspectTest.handler(
      { test: built.config, config: built.config },
      ctx
    );
    expect(both.testId).toBe(built.testId);
  });

  it("rejects a call with no test, or two tests that disagree", async () => {
    const built = await twoVariantTest();
    await expect(inspectTest.handler({}, ctx)).rejects.toThrow(ToolInputError);
    await expect(
      inspectTest.handler({ test: built.config, config: "not-the-same" }, ctx)
    ).rejects.toThrow(ToolInputError);
  });

  it("reads the query-parameter spelling too", async () => {
    const out = await inspectTest.handler(
      { test: `https://livevariant.link/s?v=${A}&v=${B}&id=x` },
      ctx
    );
    expect(out.slots[0].variants).toHaveLength(2);
    expect(out.resultsReadable).toBe(false);
  });

  it("flags a test whose results nobody will ever be able to read", async () => {
    const out = await inspectTest.handler(
      { test: `https://livevariant.link/s?v=${A}&v=${B}` },
      ctx
    );
    expect(
      out.findings.some(
        f => f.level === "error" && /never be read/.test(f.message)
      )
    ).toBe(true);
  });

  it("tells an SDK-served slot apart from a broken redirect slot", async () => {
    // All-inline is a shape the SDK serves; calling its missing serve
    // link an error was misleading (#90). Mixed really is broken.
    const content = await buildTest.handler(
      { variants: [{ text: "Ship faster" }, { text: "Ship safer" }] },
      ctx
    );
    const served = await inspectTest.handler({ test: content.config }, ctx);
    expect(served.findings.some(f => f.level === "error")).toBe(false);
    expect(
      served.findings.some(
        f => f.level === "note" && /served by the SDK/.test(f.message)
      )
    ).toBe(true);

    const mixed = await buildTest.handler(
      { variants: [{ url: A }, { text: "Buy now" }] },
      ctx
    );
    const broken = await inspectTest.handler({ test: mixed.config }, ctx);
    expect(
      broken.findings.some(
        f => f.level === "error" && /return 400/.test(f.message)
      )
    ).toBe(true);
  });

  it("notes that geo context is suppressed for email proxies", async () => {
    const built = await buildTest.handler(
      {
        variants: [{ url: A }, { url: B }],
        context: [{ key: "country", from: "country" }]
      },
      ctx
    );
    const out = await inspectTest.handler({ test: built.config }, ctx);
    expect(out.findings.some(f => /mail provider/i.test(f.message))).toBe(true);
  });

  it("refuses nonsense with a message a person can act on", async () => {
    await expect(
      inspectTest.handler({ test: "not-a-test" }, ctx)
    ).rejects.toThrow(ToolInputError);
    await expect(
      inspectTest.handler({ test: "https://livevariant.link/s" }, ctx)
    ).rejects.toThrow(/carries no LiveVariant test/);
  });
});

describe("generate_priors", () => {
  it("keeps the test's identity, which is what makes it safe mid-flight", async () => {
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: "v2", rate: 0.08 }],
        confidence: "medium"
      },
      ctx
    );
    // Priors are excluded from the identity hash on purpose: a live test
    // must keep its id and its whole event history.
    expect(out.testId).toBe(built.testId);
    expect(out.config).not.toBe(built.config);
    expect(out.manageUrl).toBe(`https://livevariant.link/manage/${out.config}`);
    const decoded = await decodeConfig(out.config);
    expect(decoded.config.priors?.main).toHaveLength(2);
  });

  it("keeps a belief about one segment off everybody else's variant", async () => {
    // The distinction the feature exists for: "B is the one for blue" is
    // not "B is the one", and writing it as the latter would steer every
    // other segment on evidence that was never about them.
    const built = await segmentedTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        when: { color: "blauw" },
        beliefs: [{ variant: "v2", rate: 0.08 }],
        confidence: "medium"
      },
      ctx
    );
    expect(out.testId).toBe(built.testId);
    const decoded = await decodeConfig(out.config);
    expect(decoded.config.priors).toBeUndefined();
    expect(decoded.config.ctxPriors).toHaveLength(1);
    expect(decoded.config.ctxPriors?.[0].when).toEqual({ color: "blauw" });

    // A second segment adds a block; the same segment replaces its own.
    const second = await generatePriors.handler(
      {
        test: out.config,
        when: { color: "rood" },
        beliefs: [{ variant: "v1", rate: 0.09 }],
        confidence: "medium"
      },
      ctx
    );
    const redone = await generatePriors.handler(
      {
        test: second.config,
        when: { color: "blauw" },
        beliefs: [{ variant: "v1", rate: 0.02 }],
        confidence: "medium"
      },
      ctx
    );
    const final = await decodeConfig(redone.config);
    expect(final.config.ctxPriors).toHaveLength(2);
    expect(final.config.ctxPriors?.map(b => b.when.color).sort()).toEqual([
      "blauw",
      "rood"
    ]);
  });

  it("tells apart two conditions that flatten to the same string", async () => {
    // Dimension keys and free-form values may contain `=` and `&`, so a
    // separator-joined identity would make `{"a": "b=c"}` and `{"a=b": "c"}`
    // the same condition and let one replace the other's block.
    const built = await buildTest.handler(
      {
        variants: [{ url: A }, { url: B }],
        context: [
          { key: "a", values: ["b=c", "x"] },
          { key: "a=b", values: ["c", "y"] }
        ]
      },
      ctx
    );
    const first = await generatePriors.handler(
      {
        test: built.config,
        when: { a: "b=c" },
        beliefs: [{ variant: 0, rate: 0.05 }],
        confidence: "low"
      },
      ctx
    );
    const second = await generatePriors.handler(
      {
        test: first.config,
        when: { "a=b": "c" },
        beliefs: [{ variant: 1, rate: 0.06 }],
        confidence: "low"
      },
      ctx
    );
    const decoded = await decodeConfig(second.config);
    expect(decoded.config.ctxPriors).toHaveLength(2);
  });

  it("refuses a segment the test does not have", async () => {
    const built = await segmentedTest();
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          when: { color: "paars" },
          beliefs: [{ variant: 0, rate: 0.05 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/not a value of "color"/);
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          when: { device: "mobile" },
          beliefs: [{ variant: 0, rate: 0.05 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/no context dimension "device"/);
  });

  it("turns a rate and a confidence into a capped prior that washes out", async () => {
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: 1, rate: 0.1 }],
        confidence: "high"
      },
      ctx
    );
    expect(out.priors).toEqual([
      { slot: "main", variant: "v2", mean: 0.1, strength: 30 }
    ]);
    expect(out.washesOutAfter).toBe(30);
  });

  it("refuses to encode certainty", async () => {
    // A prior of exactly 0 or 1 cannot be moved by any evidence, which is
    // never what someone means by "I'm sure".
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: 0, rate: 1 }],
        confidence: "low"
      },
      ctx
    );
    expect(out.priors[0].mean).toBeLessThan(1);
    expect(out.notes.join(" ")).toMatch(/certainty/i);
  });

  it("leaves unrated variants alone and says so", async () => {
    const built = await twoVariantTest();
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ variant: 0, rate: 0.05 }],
        confidence: "low"
      },
      ctx
    );
    // Only rated variants get a prior at all; the rest are named in notes.
    expect(out.priors.map(p => p.variant)).toEqual(["v1"]);
    expect(out.notes.join(" ")).toMatch(/without a prior/i);
  });

  it("demands a slot name on multi-slot tests", async () => {
    const built = await buildTest.handler(
      {
        slots: {
          hero: [{ url: A }, { url: B }],
          cta: [{ url: A }, { url: B }]
        }
      },
      ctx
    );
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          beliefs: [{ variant: 0, rate: 0.1 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/which slot/);
    const out = await generatePriors.handler(
      {
        test: built.config,
        beliefs: [{ slot: "hero", variant: 1, rate: 0.1 }],
        confidence: "low"
      },
      ctx
    );
    expect(out.testId).toBe(built.testId);
    expect(out.priors).toEqual([
      { slot: "hero", variant: "v2", mean: 0.1, strength: 5 }
    ]);
  });

  it("names the variants it does not recognize", async () => {
    const built = await twoVariantTest();
    await expect(
      generatePriors.handler(
        {
          test: built.config,
          beliefs: [{ variant: "nope", rate: 0.1 }],
          confidence: "low"
        },
        ctx
      )
    ).rejects.toThrow(/no variant called "nope"/);
  });
});

describe("get_stats", () => {
  const statsBody = {
    testId: "a".repeat(64),
    totalAssignments: 2000,
    combinations: [
      {
        cell: 0,
        choice: ["control"],
        pulls: 1000,
        conversions: 50,
        rewardTotal: 50,
        conversionRate: 0.05
      },
      {
        cell: 1,
        choice: ["variant"],
        pulls: 1000,
        conversions: 90,
        rewardTotal: 90,
        conversionRate: 0.09
      }
    ],
    slots: {
      main: [
        { name: "control", pulls: 1000, conversions: 50, conversionRate: 0.05 },
        { name: "variant", pulls: 1000, conversions: 90, conversionRate: 0.09 }
      ]
    },
    buckets: {},
    bySignal: { country: { nl: { pulls: 1200, conversions: 80 } } },
    excluded: { total: 0, bySource: 0, byWindow: 0 }
  };

  function fakeFetch(status = 200, body: unknown = statsBody) {
    const calls: Array<{ url: string; auth?: string }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)
          ?.authorization
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof globalThis.fetch;
    return { calls, impl };
  }

  it("computes the win probability rather than leaving it to be guessed", async () => {
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    const out = await getStats.handler(
      { test: built.config, statsSecret: built.statsSecret },
      { ...ctx, fetch: impl }
    );
    expect(calls[0].auth).toBe(`Bearer ${built.statsSecret}`);
    expect(out.combinations[1].probabilityBest).toBeGreaterThan(0.99);
    expect(out.decision.leader).toBe("variant");
    expect(out.decision.canStop).toBe(true);
    expect(out.decision.advice).toMatch(/winner/i);
  });

  it("takes the secret from a manage URL's fragment", async () => {
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    await getStats.handler(
      { test: built.urls.manage },
      { ...ctx, fetch: impl }
    );
    expect(calls[0].auth).toBe(`Bearer ${built.statsSecret}`);
  });

  it("never sends the secret to an origin the pasted URL chose", async () => {
    // The attack this pins: `test` arrives from a document, an email or an
    // injected instruction, while the secret can come from trusted context
    // earlier in the conversation. Honouring the URL's own origin would
    // hand that secret to whoever wrote the link.
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    await expect(
      getStats.handler(
        {
          test: `https://attacker.example/manage/${built.config}`,
          statsSecret: built.statsSecret
        },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/only ever sent to the configured server/);
    expect(calls).toHaveLength(0);
  });

  it("refuses even when the hostile URL carries its own fragment secret", async () => {
    const built = await twoVariantTest();
    const { impl, calls } = fakeFetch();
    await expect(
      getStats.handler(
        {
          test: `https://attacker.example/manage/${built.config}#${built.statsSecret}`
        },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/do not trust the link/);
    expect(calls).toHaveLength(0);
  });

  it("still works for a self-hoster whose client is configured to match", async () => {
    const built = await buildTest.handler(
      { variants: [{ url: A }, { url: B }], serverUrl: "https://ab.internal" },
      ctx
    );
    const { impl, calls } = fakeFetch();
    await getStats.handler(
      { test: built.urls.manage },
      { serverUrl: "https://ab.internal", fetch: impl }
    );
    expect(calls[0].url).toContain("https://ab.internal/stats/");
  });

  it("says plainly when there is no secret to use", async () => {
    const built = await twoVariantTest();
    await expect(getStats.handler({ test: built.config }, ctx)).rejects.toThrow(
      /no stats secret/
    );
  });

  it("reports a rejected secret as such, not as a crash", async () => {
    const built = await twoVariantTest();
    const { impl } = fakeFetch(401, { error: "stats secret required" });
    await expect(
      getStats.handler(
        { test: built.config, statsSecret: "wrong" },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/rejected that stats secret/);
  });

  it("declines to call a test that has barely run", async () => {
    const built = await twoVariantTest();
    const { impl } = fakeFetch(200, {
      ...statsBody,
      totalAssignments: 20,
      combinations: [
        {
          cell: 0,
          choice: ["control"],
          pulls: 10,
          conversions: 1,
          rewardTotal: 1,
          conversionRate: 0.1
        },
        {
          cell: 1,
          choice: ["variant"],
          pulls: 10,
          conversions: 2,
          rewardTotal: 2,
          conversionRate: 0.2
        }
      ]
    });
    const out = await getStats.handler(
      { test: built.config, statsSecret: built.statsSecret },
      { ...ctx, fetch: impl }
    );
    // Twice the conversion rate by eye, and still nowhere near callable.
    expect(out.decision.canStop).toBe(false);
    expect(out.decision.advice).toMatch(/too early/i);
  });
});

describe("upload_image", () => {
  const PNG_B64 = btoa("\x89PNG-fake-bytes");

  function assetServer(status = 201) {
    const calls: Array<{ url: string; contentType?: string; size: number }> =
      [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as Uint8Array;
      calls.push({
        url: String(url),
        contentType: (init?.headers as Record<string, string>)["content-type"],
        size: body.byteLength
      });
      if (status !== 201) {
        return Response.json({ error: "image exceeds 10 bytes" }, { status });
      }
      return Response.json(
        {
          assetId: "a".repeat(64),
          url: `https://livevariant.link/a/${"a".repeat(64)}`,
          previewUrl: `https://livevariant.link/a/${"a".repeat(64)}?e=1&s=x`,
          size: body.byteLength,
          contentType: (init?.headers as Record<string, string>)["content-type"]
        },
        { status: 201 }
      );
    }) as unknown as typeof globalThis.fetch;
    return { calls, impl };
  }

  it("uploads decoded bytes and returns the protected URL", async () => {
    const { calls, impl } = assetServer();
    const out = await uploadImage.handler(
      { data: PNG_B64, contentType: "image/png" },
      { ...ctx, fetch: impl }
    );
    expect(calls[0].url).toBe("https://livevariant.link/assets");
    expect(calls[0].contentType).toBe("image/png");
    // Decoded, not forwarded as base64: the server hashes raw bytes.
    expect(calls[0].size).toBe(atob(PNG_B64).length);
    expect(out.url).toContain("/a/");
    expect(out.previewUrl).toContain("e=");
  });

  it("says plainly when a deployment has no asset hosting", async () => {
    const { impl } = assetServer(404);
    await expect(
      uploadImage.handler(
        { data: PNG_B64, contentType: "image/png" },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/does not have asset hosting enabled/);
  });

  it("passes the server's own refusal through readably", async () => {
    const { impl } = assetServer(413);
    await expect(
      uploadImage.handler(
        { data: PNG_B64, contentType: "image/png" },
        { ...ctx, fetch: impl }
      )
    ).rejects.toThrow(/exceeds 10 bytes/);
  });

  it("rejects garbage base64 before touching the network", async () => {
    await expect(
      uploadImage.handler(
        { data: "not!!base64$$", contentType: "image/png" },
        ctx
      )
    ).rejects.toThrow(/not valid base64/);
  });
});

describe("variant_brief", () => {
  it("gives email image specs that reflect how email actually behaves", async () => {
    const out = await variantBrief.handler(
      {
        goal: "more demo bookings",
        channel: "email",
        format: "image",
        count: 3
      },
      ctx
    );
    expect(out.variantCount).toBe(3);
    expect(out.specs.join(" ")).toMatch(/600px/);
    expect(out.specs.join(" ")).toMatch(/block images/i);
    expect(out.rules.join(" ")).toMatch(/one idea per slot/i);
  });

  it("tells the caller assets are theirs to host", async () => {
    const out = await variantBrief.handler(
      { goal: "x", channel: "web", format: "url", count: 2 },
      ctx
    );
    expect(out.hosting).toMatch(/host the assets yourself/i);
  });
});

describe("get_test_status", () => {
  it("takes the secret from a manage URL and relays the registry", async () => {
    const built = await twoVariantTest();
    const calls: Array<{ encoded: string; statsSecret: string }> = [];
    const out = await getTestStatus.handler(
      { test: built.urls.manage },
      {
        ...ctx,
        accounts: {
          listTests: () => Promise.reject(new Error("not needed")),
          testStatus: async input => {
            calls.push(input);
            return {
              ok: true as const,
              testId: built.testId,
              claimed: true,
              org: { id: "org-1", name: "Acme" },
              destinations: [{ host: "cdn.example.com", verified: true }]
            };
          }
        }
      }
    );
    // The re-encoded config is canonical, so the registry is asked about
    // the SAME test the manage URL named.
    expect(calls).toEqual([
      { encoded: built.config, statsSecret: built.statsSecret }
    ]);
    expect(out).toEqual({
      testId: built.testId,
      claimed: true,
      org: "Acme",
      destinations: [{ host: "cdn.example.com", verified: true }]
    });
  });

  it("rejects without a registry, a secret, or with the wrong secret", async () => {
    const built = await twoVariantTest();
    await expect(
      getTestStatus.handler(
        { test: built.config, statsSecret: built.statsSecret },
        ctx
      )
    ).rejects.toThrow(/no account registry/);
    const accounts = {
      listTests: () => Promise.reject(new Error("not needed")),
      testStatus: async () => ({
        ok: false as const,
        reason: "bad-secret" as const
      })
    };
    await expect(
      getTestStatus.handler({ test: built.config }, { ...ctx, accounts })
    ).rejects.toThrow(/no stats secret/);
    await expect(
      getTestStatus.handler(
        { test: built.config, statsSecret: "wrong-but-long-enough" },
        { ...ctx, accounts }
      )
    ).rejects.toThrow(/does not match/);
  });
});
