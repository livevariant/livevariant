import { describe, expect, it } from "vitest";
import { autoContextDisabled, buildTestUrls } from "./urls.js";

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
