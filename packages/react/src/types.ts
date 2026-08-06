import type { ReactNode } from "react";
import type { TestUrls } from "@livevariant/core";

/**
 * The three shapes a test is created in. They all compile to the same
 * config underneath; the type decides which form the creator fills in
 * and which links or snippets they are handed afterwards.
 */
export type TestType = "email" | "redirect" | "website";

/** Everything the host app needs to persist and route after creation. */
export interface CreatedTest {
  type: TestType;
  name: string;
  encoded: string;
  testId: string;
  statsSecret: string;
  serverUrl: string;
  urls: TestUrls;
  warnings: string[];
}

export interface CreateTestProps {
  /** Default serving server (the deployment's /config serveUrl). */
  serverUrl: string;
  /** Creator's detected region; preselects the data-location choice. */
  region?: string | null;
  /** Fired the moment the test exists, BEFORE the install step shows. */
  onCreated: (test: CreatedTest) => void;
  /** Fired when the person leaves the install step ("View results"). */
  onDone?: (test: CreatedTest) => void;
  /** Start on a type (skips the picker's initial unselected state). */
  defaultType?: TestType;
  /**
   * Publishable keys of the signed-in account, for the website tag
   * snippet. Empty (or omitted) renders a placeholder key.
   */
  publishableKeys?: string[];
  /** Rendered as a link target in the redirect flow's interstitial note. */
  verifyDomainsHref?: string;
  /** Injectable for tests; used for image uploads. */
  fetch?: typeof globalThis.fetch;
  /**
   * Optional fourth picker card, "Use your LLM to do the heavy
   * lifting": clicking it renders this node (the host's agent/MCP
   * install instructions). Omitted, the card does not exist.
   */
  llmContent?: ReactNode;
}
