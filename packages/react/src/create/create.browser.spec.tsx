import { afterEach, describe, expect, it } from "vitest";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CreateTest } from "./CreateTest.js";
import type { CreatedTest } from "../types.js";

/**
 * The three creation flows in a real browser: each type gets its own
 * form and, after creating, its own deliverable (email links, redirect
 * link, website snippets). Everything runs locally: encoding a config
 * touches no network, so no server is stubbed except the upload path.
 */

let roots: Root[] = [];
let containers: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) {
    root.unmount();
  }
  for (const container of containers) {
    container.remove();
  }
  roots = [];
  containers = [];
});

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(<StrictMode>{element}</StrictMode>);
  return container;
}

async function until(check: () => boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition never became true");
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function byLabel(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector(`[aria-label="${label}"]`);
  if (!input) {
    throw new Error(`no input labelled ${label}`);
  }
  return input as HTMLInputElement;
}

function clickButton(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(b =>
    b.textContent?.includes(text)
  );
  if (!button) {
    throw new Error(`no button containing ${text}`);
  }
  button.click();
}

const SERVER = "https://serve.example";

const ignore = () => undefined;

describe("the type picker", () => {
  it("offers the three kinds and opens the matching form", async () => {
    const container = render(
      <CreateTest serverUrl={SERVER} onCreated={ignore} />
    );
    await until(
      () => container.textContent?.includes("Email / image") ?? false
    );
    expect(container.textContent).toContain("Page redirect test");
    expect(container.textContent).toContain("Website test");
    clickButton(container, "Page redirect test");
    await until(
      () => container.textContent?.includes("Destination pages") ?? false
    );
  });
});

describe("the redirect flow", () => {
  it("creates from two destination URLs and hands over the one link", async () => {
    const created: CreatedTest[] = [];
    const container = render(
      <CreateTest
        serverUrl={SERVER}
        defaultType="redirect"
        onCreated={t => created.push(t)}
        verifyDomainsHref="/settings"
      />
    );
    await until(
      () => container.textContent?.includes("Destination pages") ?? false
    );
    setValue(
      byLabel(container, "Variant 1 destination URL"),
      "https://example.com/a"
    );
    setValue(
      byLabel(container, "Variant 2 destination URL"),
      "https://example.com/b"
    );
    clickButton(container, "Create redirect test");
    await until(() => created.length > 0);
    expect(created[0].type).toBe("redirect");
    await until(
      () => container.textContent?.includes("Share the link") ?? false
    );
    // The deliverable is the serve link, plus the interstitial honesty.
    expect(container.textContent).toContain(
      `${SERVER}/s/${created[0].encoded}`
    );
    expect(container.textContent).toContain("Redirecting you to");
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
  });
});

describe("the email flow", () => {
  it("creates from image variants and hands over email-safe links", async () => {
    const created: CreatedTest[] = [];
    const container = render(
      <CreateTest
        serverUrl={SERVER}
        defaultType="email"
        onCreated={t => created.push(t)}
      />
    );
    await until(
      () => container.textContent?.includes("Image variants") ?? false
    );
    setValue(
      byLabel(container, "Element 1 variant 1 image URL"),
      "https://cdn.example/a.png"
    );
    setValue(
      byLabel(container, "Element 1 variant 2 image URL"),
      "https://cdn.example/b.png"
    );
    clickButton(container, "Create email test");
    await until(() => created.length > 0);
    expect(created[0].type).toBe("email");
    await until(
      () => container.textContent?.includes("Put it in your email") ?? false
    );
    // Email links opt out of server-derived context: mail providers
    // fetch from their own machines, and sticky assignment would bind
    // the reader to that machine's geography.
    expect(container.textContent).toContain(
      `${SERVER}/s/${created[0].encoded}?auto=0`
    );
    expect(container.textContent).toContain(
      `${SERVER}/px/${created[0].encoded}`
    );
    // The website embed: tag plus hide-until-upgraded style.
    expect(container.textContent).toContain(`${SERVER}/sdk.js`);
    expect(container.textContent).toContain("lv-reveal");
  });

  it("uploads an image through the deployment's asset store", async () => {
    const uploads: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      uploads.push(String(input));
      return Response.json({ url: "https://serve.example/a/uploaded-hash" });
    }) as typeof fetch;
    const container = render(
      <CreateTest
        serverUrl={SERVER}
        defaultType="email"
        onCreated={ignore}
        fetch={fakeFetch}
      />
    );
    await until(
      () => container.textContent?.includes("Image variants") ?? false
    );
    const file = new File(["png-bytes"], "hero.png", { type: "image/png" });
    const input = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const data = new DataTransfer();
    data.items.add(file);
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await until(
      () =>
        byLabel(container, "Element 1 variant 1 image URL").value ===
        "https://serve.example/a/uploaded-hash"
    );
    expect(uploads[0]).toBe(`${SERVER}/assets`);
  });
});

describe("multi-element email tests", () => {
  it("hands out one ?slot= link per element, sharing one assignment", async () => {
    const created: CreatedTest[] = [];
    const container = render(
      <CreateTest
        serverUrl={SERVER}
        defaultType="email"
        onCreated={t => created.push(t)}
      />
    );
    await until(
      () => container.textContent?.includes("Image variants") ?? false
    );
    setValue(
      byLabel(container, "Element 1 variant 1 image URL"),
      "https://cdn.example/hero-a.png"
    );
    setValue(
      byLabel(container, "Element 1 variant 2 image URL"),
      "https://cdn.example/hero-b.png"
    );
    clickButton(container, "Test another element at the same time");
    await until(
      () =>
        container.querySelector(
          '[aria-label="Element 2 variant 1 image URL"]'
        ) != null
    );
    setValue(
      byLabel(container, "Element 2 variant 1 image URL"),
      "https://cdn.example/cta-a.png"
    );
    setValue(
      byLabel(container, "Element 2 variant 2 image URL"),
      "https://cdn.example/cta-b.png"
    );
    clickButton(container, "Create email test");
    await until(() => created.length > 0);
    await until(
      () => container.textContent?.includes("Put it in your email") ?? false
    );
    // One link per element; the reader's single sticky assignment
    // decides the whole combination.
    const text = container.textContent ?? "";
    expect(text).toContain("slot=hero");
    expect(text).toContain("slot=element-2");
  });
});

describe("the LLM card", () => {
  it("appears only with llmContent, and opens it", async () => {
    const bare = render(<CreateTest serverUrl={SERVER} onCreated={ignore} />);
    await until(() => bare.textContent?.includes("Email / image") ?? false);
    expect(bare.textContent).not.toContain("heavy lifting");
    const container = render(
      <CreateTest
        serverUrl={SERVER}
        onCreated={ignore}
        llmContent={<div>AGENT-INSTALL-CONTENT</div>}
      />
    );
    await until(
      () => container.textContent?.includes("heavy lifting") ?? false
    );
    clickButton(container, "Use your LLM to do the heavy lifting");
    await until(
      () => container.textContent?.includes("AGENT-INSTALL-CONTENT") ?? false
    );
  });
});

describe("the website flow", () => {
  it("creates from text slots and hands over identity-preserving snippets", async () => {
    const created: CreatedTest[] = [];
    const container = render(
      <CreateTest
        serverUrl={SERVER}
        defaultType="website"
        onCreated={t => created.push(t)}
        publishableKeys={[
          "pk_first111111111111111111",
          "pk_second2222222222222222"
        ]}
      />
    );
    await until(() => container.textContent?.includes("Variants") ?? false);
    setValue(byLabel(container, "Element 1 variant 1 text"), "Ship faster");
    setValue(byLabel(container, "Element 1 variant 2 text"), "Ship safer");
    clickButton(container, "Create website test");
    await until(() => created.length > 0);
    expect(created[0].type).toBe("website");
    await until(
      () => container.textContent?.includes("Install it on your site") ?? false
    );
    const text = container.textContent ?? "";
    // The tag with the account's key, and createTest carrying the
    // ENCODED config: the page serves EXACTLY the created test, stats
    // key and identity included, not a lookalike rebuilt from slots.
    expect(text).toContain('data-publishable-key="pk_first111111111111111111"');
    expect(text).toContain("window.livevariant.sdk.createTest");
    expect(text).toContain(created[0].encoded);
    expect(text).toContain('import { createTest } from "@livevariant/sdk"');
  });

  it("bracket-accesses slots whose keys are not identifiers", async () => {
    const container = render(
      <CreateTest serverUrl={SERVER} defaultType="website" onCreated={ignore} />
    );
    await until(() => container.textContent?.includes("Variants") ?? false);
    setValue(byLabel(container, "Element 1 variant 1 text"), "A");
    setValue(byLabel(container, "Element 1 variant 2 text"), "B");
    clickButton(container, "Test another element at the same time");
    // The second element keeps its default dashed key, element-2.
    await until(
      () =>
        (
          container.querySelector(
            '[aria-label="Element 2 name"]'
          ) as HTMLInputElement | null
        )?.value === "element-2"
    );
    setValue(byLabel(container, "Element 2 variant 1 text"), "C");
    setValue(byLabel(container, "Element 2 variant 2 text"), "D");
    clickButton(container, "Create website test");
    await until(
      () => container.textContent?.includes("Install it on your site") ?? false
    );
    // Dot access on a dashed key would be subtraction, not a slot.
    expect(container.textContent).toContain('test.slots["element-2"].text');
    expect(container.textContent).toContain("test.slots.headline.text");
  });

  it("shows the placeholder key hint when the account has none", async () => {
    const container = render(
      <CreateTest serverUrl={SERVER} defaultType="website" onCreated={ignore} />
    );
    await until(() => container.textContent?.includes("Variants") ?? false);
    setValue(byLabel(container, "Element 1 variant 1 text"), "A");
    setValue(byLabel(container, "Element 1 variant 2 text"), "B");
    clickButton(container, "Create website test");
    await until(
      () => container.textContent?.includes("pk_YOUR_PUBLISHABLE_KEY") ?? false
    );
  });
});
