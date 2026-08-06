import { useRef, useState } from "react";
import { Button, Field, Input, Snippet } from "../ui.js";
import type { CreatedTest, CreateTestProps } from "../types.js";
import {
  AudienceCard,
  BasicsCard,
  finishTest,
  InstallStep,
  SlotCards,
  uploadAsset,
  useBasics,
  useSlots,
  variantName,
  withParam
} from "./shared.js";

/**
 * Email / image test: the variants are images, the deliverable is one
 * <img> URL per element that adapts per reader, and clicks are counted
 * through the click link. Like a website test, several ELEMENTS (say a
 * hero and a footer banner) can be tested at once: each element gets
 * its own ?slot= link, and one model optimizes the combination under a
 * single sticky assignment per reader.
 */

interface ImageVariant {
  name: string;
  image: string;
  /** Optional per-variant click destination. */
  url: string;
  uploading?: boolean;
  uploadError?: string;
}

function fresh(index: number): ImageVariant {
  return { name: variantName(index), image: "", url: "" };
}

/**
 * The website embed for an image test. The [src*="id="] selector also
 * matches _lvid=, so the image reveals whichever identity the tag
 * attached, and reveals anyway after the timeout when no tag runs (the
 * test then serves anonymously, exactly the no-setup floor).
 */
function websiteEmbed(
  created: CreatedTest,
  slotKeys: string[],
  publishableKey?: string
): string {
  const origin = created.serverUrl;
  const blocks = slotKeys
    .map(key => {
      const serve = key
        ? withParam(created.urls.serve, `slot=${key}`)
        : created.urls.serve;
      const click = key
        ? withParam(created.urls.click, `slot=${key}`)
        : created.urls.click;
      return `<a href="${click}"><img src="${serve}" alt="" /></a>`;
    })
    .join("\n");
  return (
    `<style>\n` +
    `  img[src^="${origin}/s/"]:not([src*="id="]) {\n` +
    `    visibility: hidden;\n` +
    `    animation: lv-reveal 0s 2.5s forwards;\n` +
    `  }\n` +
    `  @keyframes lv-reveal { to { visibility: visible } }\n` +
    `</style>\n` +
    `<script defer src="${origin}/sdk.js"\n` +
    `        data-publishable-key="${publishableKey ?? "pk_YOUR_PUBLISHABLE_KEY"}"></script>\n` +
    blocks
  );
}

export function EmailTestForm(props: CreateTestProps) {
  const basics = useBasics(props);
  const elements = useSlots<ImageVariant>(fresh, "hero");
  const [redirectUrl, setRedirectUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedTest | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<{ slot: number; index: number }>({
    slot: 0,
    index: 0
  });

  // The click endpoint's own rule: it needs a destination from ?to=, a
  // per-variant one, or the shared one, and refuses rather than send
  // people nowhere.
  const clickNeedsDestination =
    redirectUrl.trim() === "" &&
    elements.slots.some(slot => slot.variants.some(v => v.url.trim() === ""));

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const test = await finishTest({
        type: "email",
        basics,
        slots: Object.fromEntries(
          elements.slots.map(slot => [
            slot.key.trim(),
            slot.variants.map(v => ({
              name: v.name,
              image: v.image || undefined,
              url: v.url || undefined
            }))
          ])
        ),
        redirectUrl
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
    // Email links deliberately skip server-derived context: mail
    // providers open images from their own datacenters, and a sticky
    // assignment made there would be about their machine, not the
    // reader (core/urls.ts).
    const { serve, click } = created.urls.noAuto;
    const multi = elements.slots.length > 1;
    const slotKeys = multi ? elements.slots.map(slot => slot.key) : [""];
    const emailBlocks = slotKeys
      .map(key => {
        const s = key ? withParam(serve, `slot=${key}`) : serve;
        const c = key ? withParam(click, `slot=${key}`) : click;
        return `<a href="${c}&id={{contact.id}}"><img src="${s}&id={{contact.id}}" alt="" /></a>`;
      })
      .join("\n");
    return (
      <InstallStep
        title="Put it in your email"
        onDone={props.onDone && (() => props.onDone?.(created))}
      >
        <Snippet
          intro={
            multi
              ? "One image per element, all sharing ONE assignment per reader (the model optimizes the combination). The id merge tag keeps one reader one combination across opens; replace it with your email tool's tag:"
              : "The full snippet for your email template (the id merge tag keeps one reader one variant across opens; replace it with your email tool's tag):"
          }
          code={emailBlocks}
        />
        <Snippet
          intro="Counting a conversion later (a thank-you page, for example) without any script:"
          code={`<img src="${created.urls.pixel}" width="1" height="1" alt="" />`}
        />
        <Snippet
          intro="The same test on a website: the tag identifies visitors first-party and upgrades the image URLs (readers who clicked through from the email keep the exact variants their email showed). The style keeps images invisible until upgraded, revealing after 2.5s no matter what:"
          code={websiteEmbed(created, slotKeys, props.publishableKeys?.[0])}
        />
      </InstallStep>
    );
  }

  return (
    <div className="lv-root">
      <BasicsCard basics={basics} namePlaceholder="March newsletter hero" />
      <SlotCards
        state={elements}
        singleTitle="Image variants"
        description="Upload to this deployment's protected store, or paste an image URL. Optionally give a variant its own click destination."
        renderVariant={(variant, slotIndex, i) => (
          <>
            <div className="lv-row">
              <Input
                placeholder="Image URL (https://…)"
                aria-label={`Element ${slotIndex + 1} variant ${i + 1} image URL`}
                value={variant.image}
                onChange={e =>
                  elements.patchVariant(slotIndex, i, {
                    image: e.target.value
                  })
                }
              />
              <Button
                variant="outline"
                size="sm"
                disabled={variant.uploading}
                onClick={() => {
                  uploadTarget.current = { slot: slotIndex, index: i };
                  fileInput.current?.click();
                }}
              >
                {variant.uploading ? "Uploading…" : "Upload"}
              </Button>
            </div>
            <Input
              placeholder="Click destination for this variant (optional)"
              aria-label={`Element ${slotIndex + 1} variant ${i + 1} click destination`}
              value={variant.url}
              onChange={e =>
                elements.patchVariant(slotIndex, i, { url: e.target.value })
              }
            />
            {variant.uploadError && (
              <p className="lv-error">{variant.uploadError}</p>
            )}
          </>
        )}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        style={{ display: "none" }}
        onChange={e => {
          const file = e.target.files?.[0];
          const { slot, index } = uploadTarget.current;
          e.target.value = "";
          if (!file) {
            return;
          }
          elements.patchVariant(slot, index, {
            uploading: true,
            uploadError: undefined
          });
          uploadAsset(basics.effectiveServerUrl, file, props.fetch)
            .then(url =>
              elements.patchVariant(slot, index, {
                image: url,
                uploading: false
              })
            )
            .catch(err =>
              elements.patchVariant(slot, index, {
                uploading: false,
                uploadError: err instanceof Error ? err.message : String(err)
              })
            );
        }}
      />
      <AudienceCard basics={basics}>
        <Field
          label="Where clicks go"
          htmlFor="lv-redirect"
          hint="The click link counts the click, then sends people here. A per-variant destination above wins over this one."
        >
          <Input
            id="lv-redirect"
            placeholder="https://yoursite.com/offer"
            value={redirectUrl}
            onChange={e => setRedirectUrl(e.target.value)}
          />
        </Field>
        {clickNeedsDestination && (
          <p className="lv-warning">
            Some variants have no click destination and there is no shared one.
            The image works either way; the click link will refuse until a
            destination exists, rather than send readers nowhere.
          </p>
        )}
      </AudienceCard>
      {error && (
        <p className="lv-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button size="lg" disabled={busy} onClick={() => void create()}>
          Create email test
        </Button>
      </div>
    </div>
  );
}
