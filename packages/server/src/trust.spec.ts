import { describe, expect, it } from "vitest";
import {
  envTrustPolicy,
  originMatches,
  unlistedDestinationMode
} from "./trust.js";

const ctx = { testId: "t".repeat(64), requestUrl: "https://serve.test/s/x" };

describe("envTrustPolicy destinations", () => {
  it("allows everything when no list and no mode are set", async () => {
    const policy = envTrustPolicy({});
    expect(await policy.isDomainAllowedForRedirect("anywhere.test", ctx)).toBe(
      true
    );
  });

  it("blocks unlisted hosts when a list is set (classic semantics)", async () => {
    const policy = envTrustPolicy({ allowedDestinations: ["example.com"] });
    expect(await policy.isDomainAllowedForRedirect("example.com", ctx)).toBe(
      true
    );
    expect(
      await policy.isDomainAllowedForRedirect("sub.example.com", ctx)
    ).toBe(true);
    // A lookalike suffix is not a subdomain.
    expect(
      await policy.isDomainAllowedForRedirect("evil-example.com", ctx)
    ).toBe(false);
  });

  it("interstitials unlisted hosts when the mode says so", async () => {
    const policy = envTrustPolicy({
      allowedDestinations: ["example.com"],
      unlistedDestinations: "interstitial"
    });
    expect(await policy.isDomainAllowedForRedirect("example.com", ctx)).toBe(
      true
    );
    expect(await policy.isDomainAllowedForRedirect("elsewhere.test", ctx)).toBe(
      "interstitial"
    );
  });

  it("interstitials everything external with no list (hosted shape)", async () => {
    const policy = envTrustPolicy({ unlistedDestinations: "interstitial" });
    expect(await policy.isDomainAllowedForRedirect("anywhere.test", ctx)).toBe(
      "interstitial"
    );
  });
});

describe("envTrustPolicy origins", () => {
  it("allows any origin without a list", async () => {
    const policy = envTrustPolicy({});
    expect(
      await policy.isOriginAllowedForSDK("https://anywhere.test", ctx)
    ).toBe(true);
  });

  it("matches hostname entries including subdomains, on any scheme", async () => {
    const policy = envTrustPolicy({ allowedOrigins: ["example.com"] });
    expect(await policy.isOriginAllowedForSDK("https://example.com", ctx)).toBe(
      true
    );
    expect(
      await policy.isOriginAllowedForSDK("http://www.example.com", ctx)
    ).toBe(true);
    expect(
      await policy.isOriginAllowedForSDK("https://evil-example.com", ctx)
    ).toBe(false);
  });

  it("matches full-origin entries exactly", async () => {
    const policy = envTrustPolicy({
      allowedOrigins: ["https://app.example.com"]
    });
    expect(
      await policy.isOriginAllowedForSDK("https://app.example.com", ctx)
    ).toBe(true);
    expect(
      await policy.isOriginAllowedForSDK("http://app.example.com", ctx)
    ).toBe(false);
    expect(
      await policy.isOriginAllowedForSDK("https://deep.app.example.com", ctx)
    ).toBe(false);
  });

  it("rejects garbage origins", async () => {
    const policy = envTrustPolicy({ allowedOrigins: ["example.com"] });
    expect(await policy.isOriginAllowedForSDK("not a url", ctx)).toBe(false);
  });
});

describe("helpers", () => {
  it("originMatches is the same matcher the CORS preflight uses", () => {
    expect(originMatches("https://a.example.com", ["example.com"])).toBe(true);
    expect(originMatches("https://aexample.com", ["example.com"])).toBe(false);
  });

  it("unlistedDestinationMode parses known values and rejects the rest", () => {
    expect(unlistedDestinationMode("interstitial")).toBe("interstitial");
    expect(unlistedDestinationMode(" Block ")).toBe("block");
    expect(unlistedDestinationMode("allow")).toBe("allow");
    expect(unlistedDestinationMode("")).toBeUndefined();
    expect(unlistedDestinationMode("nonsense")).toBeUndefined();
    expect(unlistedDestinationMode(undefined)).toBeUndefined();
  });
});
