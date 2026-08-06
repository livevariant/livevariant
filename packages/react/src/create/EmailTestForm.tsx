import { useRef, useState } from "react";
import { Button, Card, Field, Input, Snippet } from "../ui.js";
import type { CreatedTest, CreateTestProps } from "../types.js";
import {
  AudienceCard,
  BasicsCard,
  finishTest,
  InstallStep,
  uploadAsset,
  useBasics,
  variantName
} from "./shared.js";

/**
 * Email / image test: the variants are images, the deliverable is one
 * <img> URL that adapts per open, and clicks are counted through the
 * click link. Image variants can be uploaded to the deployment's
 * protected asset store or referenced by URL.
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
function websiteEmbed(created: CreatedTest, publishableKey?: string): string {
  const origin = created.serverUrl;
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
    `<a href="${created.urls.click}"><img src="${created.urls.serve}" alt="" /></a>`
  );
}

export function EmailTestForm(props: CreateTestProps) {
  const basics = useBasics(props);
  const [variants, setVariants] = useState<ImageVariant[]>([
    fresh(0),
    fresh(1)
  ]);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedTest | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef(0);

  const patch = (index: number, part: Partial<ImageVariant>) =>
    setVariants(current =>
      current.map((v, i) => (i === index ? { ...v, ...part } : v))
    );

  // The click endpoint's own rule: it needs a destination from ?to=, a
  // per-variant one, or the shared one, and refuses rather than send
  // people nowhere.
  const clickNeedsDestination =
    redirectUrl.trim() === "" && variants.some(v => v.url.trim() === "");

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const test = await finishTest({
        type: "email",
        basics,
        slots: {
          main: variants.map(v => ({
            name: v.name,
            image: v.image || undefined,
            url: v.url || undefined
          }))
        },
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
    return (
      <InstallStep
        title="Put it in your email"
        onDone={props.onDone && (() => props.onDone?.(created))}
      >
        <Snippet
          intro="The image. One URL, a different variant per reader, learning from every open and click:"
          code={`${serve}&id={{contact.id}}`}
        />
        <Snippet
          intro="The full snippet for your email template (the id merge tag keeps one reader one variant across opens; replace it with your email tool's tag):"
          code={`<a href="${click}&id={{contact.id}}"><img src="${serve}&id={{contact.id}}" alt="" /></a>`}
        />
        <Snippet
          intro="Counting a conversion later (a thank-you page, for example) without any script:"
          code={`<img src="${created.urls.pixel}" width="1" height="1" alt="" />`}
        />
        <Snippet
          intro="The same test on a website: the tag identifies visitors first-party and upgrades the image URL (readers who clicked through from the email keep the exact variant their email showed). The style keeps the image invisible until it is upgraded, revealing after 2.5s no matter what:"
          code={websiteEmbed(created, props.publishableKeys?.[0])}
        />
      </InstallStep>
    );
  }

  return (
    <div className="lv-root">
      <BasicsCard basics={basics} namePlaceholder="March newsletter hero" />
      <Card
        title="Image variants"
        description="Upload to this deployment's protected store, or paste an image URL. Optionally give a variant its own click destination."
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
            <div className="lv-row">
              <Input
                placeholder="Image URL (https://…)"
                aria-label={`Variant ${i + 1} image URL`}
                value={variant.image}
                onChange={e => patch(i, { image: e.target.value })}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={variant.uploading}
                onClick={() => {
                  uploadTarget.current = i;
                  fileInput.current?.click();
                }}
              >
                {variant.uploading ? "Uploading…" : "Upload"}
              </Button>
            </div>
            <Input
              placeholder="Click destination for this variant (optional)"
              aria-label={`Variant ${i + 1} click destination`}
              value={variant.url}
              onChange={e => patch(i, { url: e.target.value })}
            />
            {variant.uploadError && (
              <p className="lv-error">{variant.uploadError}</p>
            )}
          </div>
        ))}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          style={{ display: "none" }}
          onChange={e => {
            const file = e.target.files?.[0];
            const index = uploadTarget.current;
            e.target.value = "";
            if (!file) {
              return;
            }
            patch(index, { uploading: true, uploadError: undefined });
            uploadAsset(basics.effectiveServerUrl, file, props.fetch)
              .then(url => patch(index, { image: url, uploading: false }))
              .catch(err =>
                patch(index, {
                  uploading: false,
                  uploadError: err instanceof Error ? err.message : String(err)
                })
              );
          }}
        />
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
