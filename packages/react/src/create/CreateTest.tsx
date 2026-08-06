import { useState, type ComponentType, type ReactNode } from "react";
import { Button } from "../ui.js";
import type { CreateTestProps, TestType } from "../types.js";
import { EmailTestForm } from "./EmailTestForm.js";
import { RedirectTestForm } from "./RedirectTestForm.js";
import { WebsiteTestForm } from "./WebsiteTestForm.js";

/**
 * The full creation flow: pick what kind of test this is, fill the form
 * that fits it, get the links or snippets that kind needs. Every kind
 * compiles to the same config and the same adaptive model underneath;
 * the type only decides the form and the deliverable.
 *
 * Embeddable: no router, no storage, no account assumptions. The host
 * passes the deployment's serving defaults in and persists the created
 * test in onCreated. A host may also pass llmContent, adding a fourth
 * card for people who would rather have their LLM build the test.
 */

/* Inline, dependency-free icons: stroke follows the text color. */
function icon(paths: ReactNode) {
  return (
    <svg
      className="lv-type-card-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

const ICONS: Record<TestType | "llm", ReactNode> = {
  email: icon(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="1.5" />
      <path d="m3 17 5-4 3 2 5-5 5 5" />
    </>
  ),
  redirect: icon(
    <>
      <path d="M4 12h12" />
      <path d="m12 6 6 6-6 6" />
      <path d="M20 5v14" />
    </>
  ),
  website: icon(
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M3 8h18" />
      <path d="M9 21h6" />
      <path d="M12 17v4" />
    </>
  ),
  llm: icon(
    <>
      <path d="M12 3v2" />
      <rect x="5" y="7" width="14" height="10" rx="2" />
      <circle cx="9.5" cy="12" r="1" />
      <circle cx="14.5" cy="12" r="1" />
      <path d="M5 12H3M21 12h-2" />
    </>
  )
};

const TYPES: {
  type: TestType;
  title: string;
  description: string;
}[] = [
  {
    type: "email",
    title: "Email / image test",
    description:
      "Variants are images. One <img> URL adapts per reader; opens and clicks teach the model. Nothing to install."
  },
  {
    type: "redirect",
    title: "Page redirect test",
    description:
      "Variants are destination pages. One link 302s each visitor to their assigned page. Perfect for ads, bio links and QR codes."
  },
  {
    type: "website",
    title: "Website test",
    description:
      "Variants are on-page content, served by the SDK or the tag. Test one element or optimize a combination of several."
  }
];

const FORMS: Record<TestType, ComponentType<CreateTestProps>> = {
  email: EmailTestForm,
  redirect: RedirectTestForm,
  website: WebsiteTestForm
};

export function CreateTest(props: CreateTestProps) {
  const [choice, setChoice] = useState<TestType | "llm" | null>(
    props.defaultType ?? null
  );

  if (!choice) {
    return (
      <div className="lv-root">
        <div className="lv-type-grid">
          {TYPES.map(entry => (
            <button
              key={entry.type}
              type="button"
              className="lv-type-card"
              aria-pressed={false}
              onClick={() => setChoice(entry.type)}
            >
              {ICONS[entry.type]}
              <span className="lv-type-card-title">{entry.title}</span>
              <span className="lv-card-description">{entry.description}</span>
            </button>
          ))}
          {props.llmContent && (
            <button
              type="button"
              className="lv-type-card"
              aria-pressed={false}
              onClick={() => setChoice("llm")}
            >
              {ICONS.llm}
              <span className="lv-type-card-title">
                Use your LLM to do the heavy lifting
              </span>
              <span className="lv-card-description">
                Your assistant drafts the variants, builds any kind of test, and
                hands you the links. Install the skills or MCP once.
              </span>
            </button>
          )}
        </div>
        <p className="lv-hint">
          These forms are just configuration helpers: every kind of test can
          also be built with plain URL parameters, or in code with the SDK.
        </p>
      </div>
    );
  }

  if (choice === "llm") {
    return (
      <div className="lv-root">
        <Button
          variant="ghost"
          size="sm"
          className="lv-back"
          onClick={() => setChoice(null)}
        >
          ← Use your LLM to do the heavy lifting
        </Button>
        {props.llmContent}
      </div>
    );
  }

  const Form = FORMS[choice];
  return (
    <div className="lv-root">
      <Button
        variant="ghost"
        size="sm"
        className="lv-back"
        onClick={() => setChoice(null)}
      >
        ← {TYPES.find(t => t.type === choice)?.title}
      </Button>
      {/* Keyed so switching type never leaks one form's state into another. */}
      <Form key={choice} {...props} />
    </div>
  );
}
