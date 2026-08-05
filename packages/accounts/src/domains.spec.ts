import { describe, expect, it } from "vitest";
import {
  generateVerificationToken,
  normalizeDomain,
  verifyDomain,
  TXT_VALUE_PREFIX,
  WELL_KNOWN_PATH
} from "./domains.js";
import { parentDomains } from "./provider.js";

describe("normalizeDomain", () => {
  it("accepts and normalizes real domains", () => {
    expect(normalizeDomain("Example.COM")).toEqual({ domain: "example.com" });
    expect(normalizeDomain("https://www.example.com/path")).toEqual({
      domain: "example.com"
    });
    expect(normalizeDomain("shop.example.co.uk")).toEqual({
      domain: "shop.example.co.uk"
    });
  });

  it("rejects what must never enter a globally unique table", () => {
    expect("error" in normalizeDomain("com")).toBe(true);
    expect("error" in normalizeDomain("localhost")).toBe(true);
    expect("error" in normalizeDomain("127.0.0.1")).toBe(true);
    expect("error" in normalizeDomain("[::1]")).toBe(true);
    expect("error" in normalizeDomain("")).toBe(true);
    expect("error" in normalizeDomain("not a domain")).toBe(true);
  });
});

describe("parentDomains", () => {
  it("walks up to the registrable domain, never a bare TLD", () => {
    expect(parentDomains("shop.example.com")).toEqual([
      "shop.example.com",
      "example.com"
    ]);
    expect(parentDomains("example.com")).toEqual(["example.com"]);
  });
});

describe("verifyDomain", () => {
  const token = generateVerificationToken();

  function dohAnswer(value: string) {
    return new Response(
      JSON.stringify({ Answer: [{ type: 16, data: `"${value}"` }] }),
      { headers: { "content-type": "application/dns-json" } }
    );
  }

  it("verifies via DNS TXT", async () => {
    const result = await verifyDomain("example.com", token, async url => {
      const u = String(url);
      if (u.includes("dns-query")) {
        expect(u).toContain("_livevariant.example.com");
        return dohAnswer(`${TXT_VALUE_PREFIX}${token}`);
      }
      return new Response("nope", { status: 404 });
    });
    expect(result).toEqual({ ok: true, method: "dns-txt" });
  });

  it("falls back to the well-known file", async () => {
    const result = await verifyDomain("example.com", token, async url => {
      const u = String(url);
      if (u.includes("dns-query")) {
        return dohAnswer("unrelated");
      }
      expect(u).toBe(`https://example.com${WELL_KNOWN_PATH}`);
      return new Response(`${token}\n`);
    });
    expect(result).toEqual({ ok: true, method: "well-known" });
  });

  it("fails when neither matches, and never follows a redirect", async () => {
    let sawRedirectMode: string | undefined;
    const result = await verifyDomain("example.com", token, (async (
      url: RequestInfo | URL,
      init?: RequestInit
    ) => {
      if (String(url).includes("dns-query")) {
        return dohAnswer("unrelated");
      }
      sawRedirectMode = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/file" }
      });
    }) as typeof fetch);
    expect(result.ok).toBe(false);
    expect(sawRedirectMode).toBe("manual");
  });

  it("rejects oversized bodies", async () => {
    const result = await verifyDomain("example.com", token, async url => {
      if (String(url).includes("dns-query")) {
        return dohAnswer("unrelated");
      }
      return new Response("x".repeat(10_000));
    });
    expect(result.ok).toBe(false);
  });
});

describe("effective TLD guard", () => {
  it("rejects two-label public suffixes, keeps real names", () => {
    expect("error" in normalizeDomain("co.uk")).toBe(true);
    expect("error" in normalizeDomain("com.au")).toBe(true);
    expect("error" in normalizeDomain("gov.br")).toBe(true);
    // Real registrable domains that share the shape must keep working.
    expect(normalizeDomain("go.com")).toEqual({ domain: "go.com" });
    expect(normalizeDomain("example.co.uk")).toEqual({
      domain: "example.co.uk"
    });
  });
});

describe("verification by installed SDK", () => {
  const token = generateVerificationToken();
  const PK = "pk_abcdefghijklmnopqrstuvwx";

  function noDnsNoFile(page: (url: string) => Response | null) {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("dns-query")) {
        return new Response(JSON.stringify({ Answer: [] }), {
          headers: { "content-type": "application/dns-json" }
        });
      }
      if (u.includes("/.well-known/")) {
        return new Response("nope", { status: 404 });
      }
      void init;
      return page(u) ?? new Response("nope", { status: 404 });
    }) as typeof fetch;
  }

  it("verifies when the publishable key sits in the homepage source", async () => {
    const result = await verifyDomain(
      "example.com",
      token,
      noDnsNoFile(url =>
        url === "https://example.com/"
          ? new Response(
              `<html><script>createTest({}, {publishableKey: "${PK}"})</script></html>`
            )
          : null
      ),
      [PK]
    );
    expect(result).toEqual({ ok: true, method: "sdk" });
  });

  it("follows one same-site redirect (apex to www), nothing foreign", async () => {
    const sameSite = await verifyDomain(
      "example.com",
      token,
      noDnsNoFile(url => {
        if (url === "https://example.com/") {
          return new Response(null, {
            status: 301,
            headers: { location: "https://www.example.com/" }
          });
        }
        if (url === "https://www.example.com/") {
          return new Response(`<script>{publishableKey:"${PK}"}</script>`);
        }
        return null;
      }),
      [PK]
    );
    expect(sameSite.method).toBe("sdk");
    const foreign = await verifyDomain(
      "example.com",
      token,
      noDnsNoFile(url =>
        url === "https://example.com/"
          ? new Response(null, {
              status: 301,
              headers: { location: "https://evil.test/" }
            })
          : new Response(`key ${PK} here`)
      ),
      [PK]
    );
    expect(foreign.ok).toBe(false);
  });

  it("fails without keys, or when the page lacks the key", async () => {
    const noKeys = await verifyDomain(
      "example.com",
      token,
      noDnsNoFile(() => new Response(`whatever ${PK}`)),
      []
    );
    expect(noKeys.ok).toBe(false);
    const wrongPage = await verifyDomain(
      "example.com",
      token,
      noDnsNoFile(() => new Response("<html>no key here</html>")),
      [PK]
    );
    expect(wrongPage.ok).toBe(false);
  });
});
