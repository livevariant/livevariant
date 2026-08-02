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
    expect(config.arms).toHaveLength(2);
    expect(config.arms[0].formats.url).toBe(A);
    expect(config.arms.map(arm => arm.name)).toEqual(["v1", "v2"]);
    expect(config.alg).toBe("ts");
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
        `v=${A}&v=${B}&vn=hero&vn=lifestyle&n=August+send&alg=bucketed` +
          `&ctx=source:utm_source,persona&r=https://shop.example.com/thanks` +
          `&stamp=utm_content&fw=0`
      )
    );
    expect(config.name).toBe("August send");
    expect(config.arms.map(arm => arm.name)).toEqual(["hero", "lifestyle"]);
    expect(config.alg).toBe("bucketed");
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
    for (const key of [
      "v",
      "vn",
      "kh",
      "alg",
      "ctx",
      "r",
      "stamp",
      "fw",
      "n"
    ]) {
      expect(isReservedParam(key)).toBe(true);
    }
    for (const key of ["id", "auto", "to", "c_country"]) {
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
