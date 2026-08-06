import { useState } from "react";
import { Button, Card, Input, Snippet } from "../ui.js";
import type { CreatedTest, CreateTestProps } from "../types.js";
import {
  AudienceCard,
  BasicsCard,
  finishTest,
  InstallStep,
  useBasics,
  variantName
} from "./shared.js";

/**
 * Page redirect test: the variants ARE destination pages, and the
 * deliverable is one link that 302s each visitor to their assigned
 * page. The straightest test to run from an ad, a bio link, or a QR
 * code: nothing to install on the pages themselves.
 */

interface UrlVariant {
  name: string;
  url: string;
}

function fresh(index: number): UrlVariant {
  return { name: variantName(index), url: "" };
}

export function RedirectTestForm(props: CreateTestProps) {
  const basics = useBasics(props);
  const [variants, setVariants] = useState<UrlVariant[]>([fresh(0), fresh(1)]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedTest | null>(null);

  const patch = (index: number, part: Partial<UrlVariant>) =>
    setVariants(current =>
      current.map((v, i) => (i === index ? { ...v, ...part } : v))
    );

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const test = await finishTest({
        type: "redirect",
        basics,
        slots: {
          main: variants.map(v => ({ name: v.name, url: v.url }))
        }
      });
      props.onCreated(test);
      setCreated(test);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <InstallStep
        title="Share the link"
        onDone={props.onDone && (() => props.onDone?.(created))}
      >
        <Snippet
          intro="The test link. Every visitor is redirected to their assigned page, and the model learns from what happens next:"
          code={created.urls.serve}
        />
        <Snippet
          intro="Counting a conversion on the destination (a thank-you page, for example):"
          code={`<img src="${created.urls.pixel}" width="1" height="1" alt="" />`}
        />
        <p className="lv-hint">
          Visitors see a brief "Redirecting you to…" page for destination
          domains that are not verified
          {props.verifyDomainsHref ? (
            <>
              {" "}
              (<a href={props.verifyDomainsHref}>verify your domain</a> to
              remove it)
            </>
          ) : (
            " (verify the destination domain in Settings to remove it)"
          )}
          .
        </p>
      </InstallStep>
    );
  }

  return (
    <div className="lv-root">
      <BasicsCard basics={basics} namePlaceholder="Landing page shootout" />
      <Card
        title="Destination pages"
        description="Each variant is a page. One link serves them all, sticky per visitor."
      >
        {variants.map((variant, i) => (
          <div key={i} className="lv-variant-row">
            <div className="lv-row">
              <Input
                aria-label={`Variant ${i + 1} name`}
                value={variant.name}
                onChange={e => patch(i, { name: e.target.value })}
              />
              {variants.length > 2 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove variant"
                  onClick={() =>
                    setVariants(current => current.filter((_, j) => j !== i))
                  }
                >
                  Remove
                </Button>
              )}
            </div>
            <Input
              placeholder="https://yoursite.com/landing-a"
              aria-label={`Variant ${i + 1} destination URL`}
              value={variant.url}
              onChange={e => patch(i, { url: e.target.value })}
            />
          </div>
        ))}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setVariants(current => [...current, fresh(current.length)])
            }
          >
            Add variant
          </Button>
        </div>
      </Card>
      <AudienceCard basics={basics} />
      {error && (
        <p className="lv-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button size="lg" disabled={busy} onClick={() => void create()}>
          Create redirect test
        </Button>
      </div>
    </div>
  );
}
