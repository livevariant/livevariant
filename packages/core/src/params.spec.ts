import { describe, expect, it } from "vitest";
import {
  configFromParams,
  decorateDestination,
  fallbackTarget,
  isReservedParam,
  passthroughParams
} from "./params.js";
import { encodeConfig } from "./codec.js";

const A = "https://cdn.example.com/hero-a.jpg";
const B = "https://cdn.example.com/hero-b.jpg";

function query(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe("configFromParams", () => {
  it("builds a whole test out of nothing but variants", async () => {
    // The point of the param form: a campaign manager fills two template
    // fields and never learns this service exists.
    const { config } = await configFromParams(query(`v=${A}&v=${B}`));
    expect(config.slots.main).toHaveLength(2);
    expect(config.slots.main[0].url).toBe(A);
    expect(config.slots.main.map((v, i) => v.name ?? `v${i + 1}`)).toEqual([
      "v1",
      "v2"
    ]);
    expect(config.forwardParams).toBe(true);
    expect(config.statsKeyHash).toBeUndefined();
  });

  it("hashes to the same test as the base64 spelling", async () => {
    // Both encodings must be two ways of writing one test, or a campaign
    // that switched forms would silently start from zero.
    const { config, testId } = await configFromParams(
      query(`v=${A}&v=${B}&kh=${"0".repeat(64)}`)
    );
    const { testId: viaBase64 } = await encodeConfig(config);
    expect(viaBase64).toBe(testId);
  });

  it("takes names, algorithm, redirect and context", async () => {
    const { config } = await configFromParams(
      query(
        `v=${A}&v=${B}&vn=hero&vn=lifestyle&n=August+send` +
          `&ctx=source:utm_source,persona&r=https://shop.example.com/thanks` +
          `&stamp=utm_content&fw=0`
      )
    );
    expect(config.name).toBe("August send");
    expect(config.slots.main.map(v => v.name)).toEqual(["hero", "lifestyle"]);
    expect(config.ctx?.dims).toEqual([
      { key: "source", from: "utm_source" },
      { key: "persona" }
    ]);
    expect(config.redirectUrl).toBe("https://shop.example.com/thanks");
    expect(config.variantParam).toBe("utm_content");
    expect(config.forwardParams).toBe(false);
  });

  it("ignores a context signal it does not recognize", async () => {
    // A typo becomes a caller-supplied dimension rather than an error:
    // the alternative is a template that renders nothing.
    const { config } = await configFromParams(
      query(`v=${A}&v=${B}&ctx=source:utm_sauce`)
    );
    expect(config.ctx?.dims).toEqual([{ key: "source" }]);
  });

  it("refuses a test that has nothing to choose between", async () => {
    await expect(configFromParams(query(`v=${A}`))).rejects.toThrow(
      /at least two/
    );
    await expect(configFromParams(query("n=empty"))).rejects.toThrow();
  });
});

describe("multi-slot query form", () => {
  it("groups variants under s= markers", async () => {
    // `s=` opens a slot; the v=/vn= that follow belong to it. This is the
    // ESP spelling of a two-element email test.
    const { config } = await configFromParams(
      query(
        `s=hero&v=${A}&v=${B}&s=cta&v=https://example.com/x&v=https://example.com/y` +
          `&vn=warm&vn=cool&vn=go&vn=wait`
      )
    );
    expect(Object.keys(config.slots).sort()).toEqual(["cta", "hero"]);
    expect(config.slots.hero.map(v => v.name)).toEqual(["warm", "cool"]);
    expect(config.slots.cta.map(v => v.name)).toEqual(["go", "wait"]);
    expect(config.slots.cta[1].url).toBe("https://example.com/y");
  });
});

describe("configToParams", () => {
  it("round-trips through configFromParams to the same testId", async () => {
    const { configToParams } = await import("./params.js");
    const original = await configFromParams(
      query(
        `s=hero&v=${A}&v=${B}&s=cta&v=https://example.com/x&v=https://example.com/y` +
          `&vn=warm&vn=cool&vn=go&vn=wait&n=Summer&ctx=country:country,persona` +
          `&r=https://example.com/lp&stamp=utm_content`
      )
    );
    const params = configToParams(original.config);
    expect(params).not.toBeNull();
    const reparsed = await configFromParams(params as URLSearchParams);
    expect(reparsed.testId).toBe(original.testId);
  });

  it("returns null for configs the parameter form cannot express", async () => {
    const { configToParams } = await import("./params.js");
    const { testConfigSchema } = await import("./schema.js");
    const inline = testConfigSchema.parse({
      variants: ["Ship faster", "Ship safer"]
    });
    expect(configToParams(inline)).toBeNull();
    const partialNames = testConfigSchema.parse({
      variants: [{ url: A, name: "hero" }, { url: B }]
    });
    expect(configToParams(partialNames)).toBeNull();
  });
});

describe("configToTemplateQuery", () => {
  it("keeps everything but the variant URLs, which become merge fields", async () => {
    const { configToTemplateQuery } = await import("./params.js");
    const kh = "a".repeat(64);
    const { config } = await configFromParams(
      query(
        `s=hero&v=${A}&v=${B}&s=cta&v=https://example.com/x&v=https://example.com/y` +
          `&vn=packshot&vn=cafe&vn=shop&vn=ritual&ctx=source:utm_source,country` +
          `&kh=${kh}`
      )
    );
    const template = configToTemplateQuery(config);
    expect(template).not.toBeNull();
    // Slot-scoped placeholders, in declaration order.
    expect(template).toContain("v={{hero_variant_1_url}}");
    expect(template).toContain("v={{cta_variant_2_url}}");
    // Names, dims and the stats key survive verbatim: template campaigns
    // must not silently lose the segments or labels the plan configured.
    expect(template).toContain("vn=packshot");
    expect(template).toContain("vn=ritual");
    expect(template).toContain(encodeURIComponent("source:utm_source"));
    expect(template).toContain(`kh=${kh}`);
    // No redirectUrl in the config: the landing page becomes a merge
    // field too, on the ONE shared string every link reuses.
    expect(template).toContain("r={{landing_url}}");
  });

  it("keeps a configured redirectUrl instead of a placeholder", async () => {
    const { configToTemplateQuery } = await import("./params.js");
    const { config } = await configFromParams(
      query(`v=${A}&v=${B}&r=https://shop.example.com/lp`)
    );
    const template = configToTemplateQuery(config);
    expect(template).toContain(
      `r=${encodeURIComponent("https://shop.example.com/lp")}`
    );
    expect(template).not.toContain("{{landing_url}}");
    // Single-slot placeholders carry no slot prefix.
    expect(template).toContain("v={{variant_1_url}}");
  });

  it("filled in, serve and click spellings hash to ONE test", async () => {
    // The invariant the whole template rests on: r is identity, so it
    // must ride on every link; a template whose click link disagreed
    // with its image links would reward a test nobody is serving.
    const { configToTemplateQuery } = await import("./params.js");
    const { config } = await configFromParams(
      query(`s=hero&v=${A}&v=${B}&s=cta&v=${A}&v=${B}&kh=${"b".repeat(64)}`)
    );
    const filled = (configToTemplateQuery(config) as string)
      .replace("{{hero_variant_1_url}}", encodeURIComponent(A))
      .replace("{{hero_variant_2_url}}", encodeURIComponent(B))
      .replace("{{cta_variant_1_url}}", encodeURIComponent(A))
      .replace("{{cta_variant_2_url}}", encodeURIComponent(B))
      .replace("{{landing_url}}", encodeURIComponent("https://example.com/lp"));
    // Runtime params differ per link and must not affect identity.
    const serveHero = await configFromParams(
      query(`${filled}&auto=0&id=r1&slot=hero`)
    );
    const serveCta = await configFromParams(
      query(`${filled}&auto=0&id=r1&slot=cta`)
    );
    const click = await configFromParams(query(`${filled}&id=r1`));
    expect(serveCta.testId).toBe(serveHero.testId);
    expect(click.testId).toBe(serveHero.testId);
  });

  it("has no spelling when the config has none", async () => {
    const { configToTemplateQuery } = await import("./params.js");
    const { testConfigSchema } = await import("./schema.js");
    const inline = testConfigSchema.parse({
      variants: ["warm copy", "cool copy"]
    });
    expect(configToTemplateQuery(inline)).toBeNull();
  });
});

describe("passthroughParams", () => {
  it("keeps attribution and drops everything of ours", async () => {
    const params = passthroughParams(
      query(
        `v=${A}&v=${B}&kh=abc&id=u1&auto=0&c_persona=power` +
          "&utm_source=newsletter&gclid=xyz"
      )
    );
    expect(params).toEqual([
      ["utm_source", "newsletter"],
      ["gclid", "xyz"]
    ]);
  });

  it("treats every config and runtime name as ours", () => {
    for (const key of ["v", "vn", "kh", "s", "ctx", "r", "stamp", "fw", "n"]) {
      expect(isReservedParam(key)).toBe(true);
    }
    for (const key of ["id", "auto", "to", "slot", "c_country"]) {
      expect(isReservedParam(key)).toBe(true);
    }
    for (const key of ["utm_source", "gclid", "mc_cid", "c_"]) {
      expect(isReservedParam(key)).toBe(false);
    }
  });
});

describe("decorateDestination", () => {
  it("carries attribution onto the destination", () => {
    expect(
      decorateDestination("https://shop.example.com/p", {
        passthrough: [["utm_source", "newsletter"]]
      })
    ).toBe("https://shop.example.com/p?utm_source=newsletter");
  });

  it("never overwrites what the destination already says", () => {
    // The config author wrote that parameter deliberately; losing it
    // would be worse than dropping an attribution tag.
    expect(
      decorateDestination("https://shop.example.com/p?utm_source=direct", {
        passthrough: [["utm_source", "newsletter"]]
      })
    ).toBe("https://shop.example.com/p?utm_source=direct");
  });

  it("stamps the served variant where asked", () => {
    expect(
      decorateDestination("https://shop.example.com/p", {
        variantParam: "utm_content",
        variantValue: "hero"
      })
    ).toBe("https://shop.example.com/p?utm_content=hero");
  });

  it("leaves something that is not a URL alone", () => {
    expect(decorateDestination("not a url", { variantParam: "x" })).toBe(
      "not a url"
    );
  });
});

describe("fallbackTarget", () => {
  it("finds the first servable variant for the failure path", () => {
    expect(fallbackTarget(query(`v=${A}&v=${B}`))).toBe(A);
    expect(fallbackTarget(query(`v=oops&v=${B}`))).toBe(B);
  });

  it("gives up rather than redirect somewhere strange", () => {
    expect(fallbackTarget(query("v=javascript:alert(1)"))).toBeNull();
    expect(fallbackTarget(query("n=nothing"))).toBeNull();
  });
});
