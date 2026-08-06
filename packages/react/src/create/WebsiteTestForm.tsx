import { useState } from "react";
import { cellCount, MAX_CELLS } from "@livevariant/core";
import { Button, Card, Field, Input, Select, Snippet } from "../ui.js";
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

interface SlotDraft {
  key: string;
  variants: TextVariant[];
}

function fresh(index: number): TextVariant {
  return { name: variantName(index), text: "" };
}

const PLACEHOLDER_KEY = "pk_YOUR_PUBLISHABLE_KEY";

export function WebsiteTestForm(props: CreateTestProps) {
  const basics = useBasics(props);
  const [slots, setSlots] = useState<SlotDraft[]>([
    { key: "headline", variants: [fresh(0), fresh(1)] }
  ]);
  const [rewardEvents, setRewardEvents] = useState("");
  const keys = props.publishableKeys ?? [];
  const [pk, setPk] = useState<string | null>(null);
  const activeKey = pk ?? keys[0] ?? PLACEHOLDER_KEY;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedTest | null>(null);

  const combinations = cellCount(slots.map(slot => slot.variants.length));

  const patchSlot = (index: number, part: Partial<SlotDraft>) =>
    setSlots(current =>
      current.map((slot, i) => (i === index ? { ...slot, ...part } : slot))
    );
  const patchVariant = (
    slotIndex: number,
    index: number,
    part: Partial<TextVariant>
  ) =>
    patchSlot(slotIndex, {
      variants: slots[slotIndex].variants.map((v, j) =>
        j === index ? { ...v, ...part } : v
      )
    });

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const test = await finishTest({
        type: "website",
        basics,
        slots: Object.fromEntries(
          slots.map(slot => [
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
    const applyLines = slots
      .map(
        slot =>
          `document.querySelector("#${slot.key}").textContent =\n  test.slots.${slot.key}.text;`
      )
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
      {slots.map((slot, slotIndex) => (
        <Card
          key={slotIndex}
          title={
            slots.length > 1 ? (
              <span className="lv-row">
                Element
                <Input
                  aria-label={`Element ${slotIndex + 1} name`}
                  value={slot.key}
                  onChange={e =>
                    patchSlot(slotIndex, {
                      key: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_-]/g, "")
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove element"
                  onClick={() =>
                    setSlots(current =>
                      current.filter((_, j) => j !== slotIndex)
                    )
                  }
                >
                  Remove
                </Button>
              </span>
            ) : (
              "Variants"
            )
          }
          description="The text alternatives this element cycles through while the model learns."
        >
          {slot.variants.map((variant, i) => (
            <div key={i} className="lv-variant-row">
              <div className="lv-row">
                <Input
                  aria-label={`Variant ${i + 1} name`}
                  value={variant.name}
                  onChange={e =>
                    patchVariant(slotIndex, i, { name: e.target.value })
                  }
                />
                {slot.variants.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remove variant"
                    onClick={() =>
                      patchSlot(slotIndex, {
                        variants: slot.variants.filter((_, j) => j !== i)
                      })
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
              <Input
                placeholder="Ship faster with adaptive testing"
                aria-label={`Variant ${i + 1} text`}
                value={variant.text}
                onChange={e =>
                  patchVariant(slotIndex, i, { text: e.target.value })
                }
              />
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patchSlot(slotIndex, {
                  variants: [...slot.variants, fresh(slot.variants.length)]
                })
              }
            >
              Add variant
            </Button>
          </div>
        </Card>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setSlots(current => [
              ...current,
              {
                key: `element-${current.length + 1}`,
                variants: [fresh(0), fresh(1)]
              }
            ])
          }
        >
          Test another element at the same time
        </Button>
        <p className="lv-hint">
          With several elements (a hero AND a call-to-action) one model
          optimizes the combination.
          {slots.length > 1 && ` Currently ${combinations} combinations.`}
        </p>
        {combinations > MAX_CELLS && (
          <p className="lv-error">
            {combinations} combinations exceeds the {MAX_CELLS} limit; use fewer
            variants per element.
          </p>
        )}
      </div>
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
