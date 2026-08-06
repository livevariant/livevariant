import { useState, type ComponentType } from "react";
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
 * test in onCreated.
 */

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
  const [type, setType] = useState<TestType | null>(props.defaultType ?? null);

  if (!type) {
    return (
      <div className="lv-root">
        <div className="lv-type-grid">
          {TYPES.map(entry => (
            <button
              key={entry.type}
              type="button"
              className="lv-type-card"
              aria-pressed={false}
              onClick={() => setType(entry.type)}
            >
              <span className="lv-type-card-title">{entry.title}</span>
              <span className="lv-card-description">{entry.description}</span>
            </button>
          ))}
        </div>
        <p className="lv-hint">
          Every kind runs the same adaptive model: there is no algorithm to
          pick, and the test keeps learning for as long as it serves.
        </p>
      </div>
    );
  }

  const Form = FORMS[type];
  return (
    <div className="lv-root">
      <Button
        variant="ghost"
        size="sm"
        className="lv-back"
        onClick={() => setType(null)}
      >
        ← {TYPES.find(t => t.type === type)?.title}
      </Button>
      {/* Keyed so switching type never leaks one form's state into another. */}
      <Form key={type} {...props} />
    </div>
  );
}
