import { useState } from "react";
import { Button, Field, Input, Select, Snippet } from "../ui.js";
import type { CreatedTest, CreateTestProps } from "../types.js";
import {
  AudienceCard,
  BasicsCard,
  finishTest,
  InstallStep,
  SlotCards,
  useBasics,
  useSlots,
  variantName
} from "./shared.js";

/**
 * Website test: on-page content served by the SDK. Each element (slot)
 * carries text variants; with several elements one model optimizes the
 * COMBINATION, which two separate tests cannot see. The install step
 * hands over the tag and a createTest call carrying the ENCODED config,
 * so the page serves exactly the test that was created here, identity
 * and stats key included.
 */

interface TextVariant {
  name: string;
  text: string;
}

function fresh(index: number): TextVariant {
  return { name: variantName(index), text: "" };
}

const PLACEHOLDER_KEY = "pk_YOUR_PUBLISHABLE_KEY";

export function WebsiteTestForm(props: CreateTestProps) {
  const basics = useBasics(props);
  const elements = useSlots<TextVariant>(fresh, "headline");
  const [rewardEvents, setRewardEvents] = useState("");
  const keys = props.publishableKeys ?? [];
  const [pk, setPk] = useState<string | null>(null);
  const activeKey = pk ?? keys[0] ?? PLACEHOLDER_KEY;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedTest | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const test = await finishTest({
        type: "website",
        basics,
        slots: Object.fromEntries(
          elements.slots.map(slot => [
            slot.key.trim(),
            slot.variants.map(v => ({ name: v.name, text: v.text }))
          ])
        ),
        rewardEvents: rewardEvents
          ? rewardEvents
              .split(",")
              .map(e => e.trim())
              .filter(Boolean)
          : undefined
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
    const applyLines = elements.slots
      .map(slot => {
        // Keys like "element-2" are not identifiers: dot access would
        // parse as subtraction in the pasted snippet.
        const access = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(slot.key)
          ? `test.slots.${slot.key}.text`
          : `test.slots["${slot.key}"].text`;
        return `document.querySelector("#${slot.key}").textContent =\n  ${access};`;
      })
      .join("\n");
    return (
      <InstallStep
        title="Install it on your site"
        onDone={props.onDone && (() => props.onDone?.(created))}
      >
        {keys.length > 1 && (
          <Field
            label="Publishable key for the snippets"
            htmlFor="lv-pk"
            hint="Any key of the organization that should own this test's registration."
          >
            <Select
              id="lv-pk"
              value={activeKey}
              onChange={e => setPk(e.target.value)}
            >
              {keys.map(key => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Snippet
          intro="The tag, once, in <head> (or as a Google Tag Manager Custom HTML tag with 'Support document.write' ticked). It carries the page config and tracks conversions on its own:"
          code={`<script defer src="${created.serverUrl}/sdk.js"\n        data-publishable-key="${activeKey}"></script>`}
        />
        <Snippet
          intro="Then serve the test where the content lives. The encoded string IS this exact test (identity, region and stats key included):"
          code={`const test = await window.livevariant.sdk.createTest(\n  "${created.encoded}"\n);\n${applyLines}`}
        />
        <Snippet
          intro="Prefer a bundler? Same call via npm (npm i @livevariant/sdk); with the tag on the page no options are needed:"
          code={`import { createTest } from "@livevariant/sdk";\n\nconst test = await createTest("${created.encoded}");\n${applyLines}`}
        />
        {keys.length === 0 && (
          <p className="lv-hint">
            Replace {PLACEHOLDER_KEY} with a publishable key from Settings;
            paired with your verified domain it makes this test appear under My
            tests automatically.
          </p>
        )}
      </InstallStep>
    );
  }

  return (
    <div className="lv-root">
      <BasicsCard basics={basics} namePlaceholder="Homepage hero headline" />
      <SlotCards
        state={elements}
        description="The text alternatives this element cycles through while the model learns."
        renderVariant={(variant, slotIndex, i) => (
          <Input
            placeholder="Ship faster with adaptive testing"
            aria-label={`Element ${slotIndex + 1} variant ${i + 1} text`}
            value={variant.text}
            onChange={e =>
              elements.patchVariant(slotIndex, i, { text: e.target.value })
            }
          />
        )}
      />
      <AudienceCard basics={basics}>
        <Field
          label="Reward events (GA4, comma-separated)"
          htmlFor="lv-rewards"
          hint="Conversions counted from your existing analytics events; sensible defaults if empty."
        >
          <Input
            id="lv-rewards"
            placeholder="purchase, sign_up"
            value={rewardEvents}
            onChange={e => setRewardEvents(e.target.value)}
          />
        </Field>
      </AudienceCard>
      {error && (
        <p className="lv-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button size="lg" disabled={busy} onClick={() => void create()}>
          Create website test
        </Button>
      </div>
    </div>
  );
}
