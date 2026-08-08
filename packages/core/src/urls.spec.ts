import { describe, expect, it } from "vitest";
import { assetIdFromUrl, autoContextDisabled, buildTestUrls } from "./urls.js";

describe("buildTestUrls", () => {
  const urls = buildTestUrls("https://livevariant.link/", "CFG", "s3cret");

  it("builds every serving link off one origin", () => {
    expect(urls.serve).toBe("https://livevariant.link/s/CFG");
    expect(urls.click).toBe("https://livevariant.link/c/CFG");
    expect(urls.pixel).toBe("https://livevariant.link/px/CFG");
  });

  it("offers email links that never derive context", () => {
    expect(urls.noAuto.serve).toBe("https://livevariant.link/s/CFG?auto=0");
    expect(urls.noAuto.click).toBe("https://livevariant.link/c/CFG?auto=0");
  });

  it("keeps the stats secret in the fragment", () => {
    // A query string reaches server and proxy logs; a fragment never
    // leaves the browser.
    expect(urls.manage).toBe("https://livevariant.link/manage/CFG#s3cret");
    expect(buildTestUrls("https://livevariant.link", "CFG").manage).toBe(
      "https://livevariant.link/manage/CFG"
    );
  });
});

describe("autoContextDisabled", () => {
  it("accepts the spellings a person would reach for", () => {
    // These links are pasted into ESP templates by hand, where a silent
    // misread looks exactly like working code.
    for (const flag of ["0", "false", "off", "no", "OFF", " false "]) {
      expect(autoContextDisabled(flag)).toBe(true);
    }
  });

  it("leaves derivation on for anything else", () => {
    for (const flag of [undefined, "", "1", "true", "on", "yes"]) {
      expect(autoContextDisabled(flag)).toBe(false);
    }
  });
});

describe("assetIdFromUrl", () => {
  const id = "a".repeat(64);

  it("reads the hash off a canonical asset URL", () => {
    expect(assetIdFromUrl(`https://x.test/a/${id}`)).toBe(id);
  });

  it("requires the deployment's own base path, and nothing else", () => {
    // This answer decides whether a redirect target counts as OURS and
    // may skip the trust policy, so a loose match would hand that bypass
    // to any /…/a/<64 hex> path on the same host.
    expect(assetIdFromUrl(`https://x.test/lv/a/${id}`, "/lv")).toBe(id);
    expect(assetIdFromUrl(`https://x.test/lv/a/${id}`)).toBeNull();
    expect(assetIdFromUrl(`https://x.test/a/${id}`, "/lv")).toBeNull();
    expect(assetIdFromUrl(`https://x.test/uploads/a/${id}`, "/lv")).toBeNull();
  });

  it("is null for anything that is not one", () => {
    expect(assetIdFromUrl("https://x.test/a/nothex")).toBeNull();
    expect(assetIdFromUrl("not a url")).toBeNull();
  });
});
