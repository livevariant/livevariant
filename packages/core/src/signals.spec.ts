import { describe, expect, it } from "vitest";
import {
  deviceClass,
  isAssetFetch,
  primaryLanguage,
  requestSignals
} from "./signals.js";

describe("deviceClass", () => {
  it("separates the three classes that are worth testing against", () => {
    expect(
      deviceClass(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15"
      )
    ).toBe("mobile");
    expect(
      deviceClass("Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit/605.1")
    ).toBe("tablet");
    expect(
      deviceClass("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120")
    ).toBe("desktop");
  });

  it("tells an Android tablet from an Android phone", () => {
    // Android phones say "Mobile", tablets omit it: the classic trap.
    expect(
      deviceClass("Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile")
    ).toBe("mobile");
    expect(deviceClass("Mozilla/5.0 (Linux; Android 14) Chrome/120")).toBe(
      "tablet"
    );
  });

  it("yields nothing without a user agent", () => {
    expect(deviceClass(undefined)).toBeUndefined();
  });
});

describe("primaryLanguage", () => {
  it("takes the first subtag and drops the region and weight", () => {
    expect(primaryLanguage("nl-NL,nl;q=0.9,en-US;q=0.8")).toBe("nl");
    expect(primaryLanguage("en-GB")).toBe("en");
  });

  it("ignores junk", () => {
    expect(primaryLanguage(undefined)).toBeUndefined();
    expect(primaryLanguage("*")).toBeUndefined();
    expect(primaryLanguage("")).toBeUndefined();
  });
});

describe("requestSignals", () => {
  it("normalizes what Cloudflare provides", () => {
    const signals = requestSignals({
      geo: {
        country: "NL",
        continent: "EU",
        regionCode: "NH",
        city: "Amsterdam",
        timezone: "Europe/Amsterdam",
        asOrganization: "KPN B.V."
      },
      userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1",
      acceptLanguage: "nl-NL,nl;q=0.9"
    });
    expect(signals).toEqual({
      country: "nl",
      continent: "eu",
      region: "nh",
      city: "amsterdam",
      timezone: "Europe/Amsterdam",
      organization: "kpn b.v.",
      device: "mobile",
      language: "nl"
    });
  });

  it("drops Cloudflare's placeholders rather than bucketing them", () => {
    // T1 is Tor and XX is unknown: recording them as countries would
    // invent segments that do not exist.
    const signals = requestSignals({ geo: { country: "T1", continent: "XX" } });
    expect(signals.country).toBeUndefined();
    expect(signals.continent).toBeUndefined();
  });

  it("works with no geo at all, which is every non-Cloudflare host", () => {
    const signals = requestSignals({
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/120",
      acceptLanguage: "en-US"
    });
    expect(signals).toEqual({ device: "desktop", language: "en" });
  });
});

describe("isAssetFetch", () => {
  it("recognizes an image fetch, which is a mail proxy not a person", () => {
    expect(isAssetFetch({ secFetchDest: "image" })).toBe(true);
    expect(isAssetFetch({ accept: "image/webp,image/*,*/*;q=0.8" })).toBe(true);
  });

  it("treats a page navigation as a person", () => {
    expect(isAssetFetch({ secFetchDest: "document" })).toBe(false);
    expect(
      isAssetFetch({ accept: "text/html,application/xhtml+xml,image/webp" })
    ).toBe(false);
  });

  it("does not take a bare */* for a person", () => {
    // The gap that matters: a mail proxy that sends no sec-fetch-dest and
    // a wildcard Accept would otherwise be recorded as the reader, and a
    // datacenter's country would enter the test as if it were real.
    expect(isAssetFetch({ accept: "*/*" })).toBe(true);
    expect(isAssetFetch({})).toBe(true);
  });
});

describe("regionHint", () => {
  it("maps continents to placement hints, with the known splits", async () => {
    const { regionHint } = await import("./signals.js");
    expect(regionHint({ continent: "EU", country: "NL" })).toBe("weur");
    expect(regionHint({ continent: "EU", country: "PL" })).toBe("eeur");
    expect(regionHint({ continent: "NA", country: "US" })).toBe("enam");
    expect(regionHint({ continent: "AS", country: "JP" })).toBe("apac");
    expect(regionHint({ continent: "AS", country: "AE" })).toBe("me");
    expect(regionHint({ continent: "SA" })).toBe("sam");
    expect(regionHint({ continent: "OC" })).toBe("oc");
    expect(regionHint({ continent: "AF" })).toBe("afr");
    expect(regionHint(null)).toBeNull();
    expect(regionHint({})).toBeNull();
  });
});

describe("geoFromRequest", () => {
  it("prefers the platform object when there is one", async () => {
    const { geoFromRequest } = await import("./signals.js");
    const request = Object.assign(new Request("https://x.test/s"), {
      cf: { country: "NL", continent: "EU" }
    });
    expect(geoFromRequest(request)).toEqual({ country: "NL", continent: "EU" });
  });

  it("falls back to the header form, decoding what is encoded", async () => {
    const { geoFromRequest } = await import("./signals.js");
    const request = new Request("https://x.test/s", {
      headers: {
        "x-vercel-ip-country": "US",
        "x-vercel-ip-continent": "NA",
        "x-vercel-ip-country-region": "CA",
        "x-vercel-ip-city": "San%20Francisco",
        "x-vercel-ip-timezone": "America/Los_Angeles"
      }
    });
    expect(geoFromRequest(request)).toEqual({
      country: "US",
      continent: "NA",
      regionCode: "CA",
      city: "San Francisco",
      timezone: "America/Los_Angeles"
    });
  });

  it("says nothing rather than something empty", async () => {
    // Null leaves device and language as the only context, which is the
    // honest answer; an object of undefineds would read as "we looked and
    // the visitor is nowhere".
    const { geoFromRequest } = await import("./signals.js");
    expect(geoFromRequest(new Request("https://x.test/s"))).toBeNull();
  });
});
