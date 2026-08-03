import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Plus, Trash2 } from "lucide-react";
import {
  cellCount,
  encodeConfig,
  generateStatsSecret,
  hashStatsSecret,
  MAX_CELLS,
  type TestConfigInput,
  type TestRegion
} from "@livevariant/core";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { saveTest } from "@/lib/tests-store";
import { useDeploymentConfig } from "@/lib/serve-url";

interface VariantDraft {
  name: string;
  url: string;
  image: string;
  text: string;
  uploading?: boolean;
  uploadError?: string;
}

interface SlotDraft {
  key: string;
  variants: VariantDraft[];
}

function freshVariant(index: number): VariantDraft {
  return {
    // a..z, then plain numbers past 26 variants.
    name:
      index === 0
        ? "control"
        : `variant-${index < 26 ? String.fromCharCode(96 + index) : index + 1}`,
    url: "",
    image: "",
    text: ""
  };
}

export function Builder() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  // Detected from the deployment, until the person types their own.
  const deployment = useDeploymentConfig();
  const detectedServerUrl = deployment.serveUrl;
  const [serverOverride, setServerOverride] = useState<string | null>(null);
  const serverUrl = serverOverride ?? detectedServerUrl;
  // Guarded at use, not in the change handler: an empty field has to stay
  // empty while someone clears it to type a new one, but an empty serving
  // origin would build relative URLs that serve nothing.
  const effectiveServerUrl = serverUrl.trim() || detectedServerUrl;
  // One slot is the classic A/B test; more slots make the test optimize
  // the COMBINATION of elements (hero x cta), which is the point of the
  // one-model design.
  const [slots, setSlots] = useState<SlotDraft[]>([
    { key: "main", variants: [freshVariant(0), freshVariant(1)] }
  ]);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [ctxKeys, setCtxKeys] = useState("");
  const [rewardEvents, setRewardEvents] = useState("");
  // null = follow the detected creator region; "" = explicit none.
  const [regionOverride, setRegionOverride] = useState<string | null>(null);
  const region = regionOverride ?? deployment.region ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const multiSlot = slots.length > 1;
  const combinations = cellCount(slots.map(slot => slot.variants.length));

  // The exact condition the click endpoint enforces: it needs ?to=, a
  // per-variant redirectUrl, or this one. Variants with a destination are
  // the case where someone is likely to want click tracking and be
  // surprised by a 400 in the middle of a campaign.
  const needsRedirectUrl =
    redirectUrl.trim() === "" &&
    slots.some(slot => slot.variants.some(v => v.url.trim() !== ""));

  const dims = useMemo(
    () =>
      ctxKeys
        .split(",")
        .map(k => k.trim())
        .filter(Boolean)
        .map(key => ({ key })),
    [ctxKeys]
  );

  function setSlot(slotIndex: number, patch: Partial<SlotDraft>) {
    setSlots(current =>
      current.map((slot, i) => (i === slotIndex ? { ...slot, ...patch } : slot))
    );
  }

  function setVariant(
    slotIndex: number,
    index: number,
    patch: Partial<VariantDraft>
  ) {
    setSlots(current =>
      current.map((slot, i) =>
        i === slotIndex
          ? {
              ...slot,
              variants: slot.variants.map((variant, j) =>
                j === index ? { ...variant, ...patch } : variant
              )
            }
          : slot
      )
    );
  }

  /**
   * Uploads to the deployment's asset store and drops the returned
   * protected URL into the image field. The URL 403s outside a test's
   * serving flow, which is the point: hosting here is for variants, not
   * for hotlinking.
   */
  async function uploadImage(slotIndex: number, index: number, file: File) {
    setVariant(slotIndex, index, { uploading: true, uploadError: undefined });
    try {
      const res = await fetch(`${effectiveServerUrl}/assets`, {
        method: "POST",
        headers: { "content-type": file.type },
        body: file
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        throw new Error(
          body.error ??
            (res.status === 404
              ? "this server has image hosting disabled"
              : `upload failed (${res.status})`)
        );
      }
      setVariant(slotIndex, index, { image: body.url, uploading: false });
    } catch (err) {
      setVariant(slotIndex, index, {
        uploading: false,
        uploadError: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const statsSecret = generateStatsSecret();
      const config: TestConfigInput = {
        v: 2,
        name: name || undefined,
        slots: Object.fromEntries(
          slots.map(slot => [
            slot.key.trim(),
            slot.variants.map(variant => ({
              name: variant.name,
              url: variant.url || undefined,
              image: variant.image || undefined,
              text: variant.text || undefined
            }))
          ])
        ),
        ctx: dims.length > 0 ? { dims } : undefined,
        region: region ? (region as TestRegion) : undefined,
        redirectUrl: redirectUrl || undefined,
        rewardEvents: rewardEvents
          ? rewardEvents
              .split(",")
              .map(e => e.trim())
              .filter(Boolean)
          : undefined,
        statsKeyHash: await hashStatsSecret(statsSecret)
      };
      const { encoded, testId, warnings } = await encodeConfig(config);
      saveTest({
        name: name || "Untitled test",
        encoded,
        testId,
        statsSecret,
        serverUrl: effectiveServerUrl.replace(/\/+$/, ""),
        createdAt: Date.now()
      });
      if (warnings.length > 0) {
        console.warn(warnings.join("\n"));
      }
      navigate(`/tests/${testId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Create a test</h1>
        <p className="text-sm text-muted-foreground">
          Everything is built in your browser: the config becomes a URL, the
          stats secret stays with you, and nothing is registered anywhere. There
          is no algorithm to pick; every test runs the same adaptive model,
          sized from its shape.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Test name</Label>
            <Input
              id="name"
              placeholder="Homepage hero headline"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="server">Serving server</Label>
            <Input
              id="server"
              value={serverUrl}
              onChange={e => setServerOverride(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The hosted server, or your own (AGPL, self-hostable).
            </p>
          </div>
        </CardContent>
      </Card>

      {slots.map((slot, slotIndex) => (
        <Card key={slotIndex}>
          <CardHeader>
            {multiSlot ? (
              <div className="flex items-center gap-2">
                <CardTitle className="shrink-0">Element</CardTitle>
                <Input
                  aria-label={`Element ${slotIndex + 1} name`}
                  className="max-w-40"
                  value={slot.key}
                  onChange={e =>
                    setSlot(slotIndex, {
                      key: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_-]/g, "")
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove element"
                  className="ml-auto"
                  onClick={() =>
                    setSlots(current =>
                      current.filter((_, j) => j !== slotIndex)
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ) : (
              <CardTitle>Variants</CardTitle>
            )}
            <CardDescription>
              Give each variant a destination URL (email/redirect tests), inline
              text (SDK tests), or both.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {slot.variants.map((variant, i) => (
              <div key={i} className="space-y-2 rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Variant ${i + 1} name`}
                    className="max-w-48"
                    value={variant.name}
                    onChange={e =>
                      setVariant(slotIndex, i, { name: e.target.value })
                    }
                  />
                  {slot.variants.length > 2 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove variant"
                      onClick={() =>
                        setSlot(slotIndex, {
                          variants: slot.variants.filter((_, j) => j !== i)
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
                <Input
                  placeholder="Destination URL (https://…)"
                  value={variant.url}
                  onChange={e =>
                    setVariant(slotIndex, i, { url: e.target.value })
                  }
                />
                <Input
                  placeholder="Inline text (for SDK serving)"
                  value={variant.text}
                  onChange={e =>
                    setVariant(slotIndex, i, { text: e.target.value })
                  }
                />
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Image URL (email tests)"
                    value={variant.image}
                    onChange={e =>
                      setVariant(slotIndex, i, { image: e.target.value })
                    }
                  />
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                    className="hidden"
                    id={`slot-${slotIndex}-variant-${i}-upload`}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) {
                        void uploadImage(slotIndex, i, file);
                      }
                      e.target.value = "";
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={variant.uploading}
                    onClick={() =>
                      document
                        .getElementById(`slot-${slotIndex}-variant-${i}-upload`)
                        ?.click()
                    }
                  >
                    {variant.uploading ? "Uploading…" : "Upload"}
                  </Button>
                </div>
                {variant.uploadError && (
                  <p className="text-xs text-red-600">{variant.uploadError}</p>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setSlot(slotIndex, {
                  variants: [
                    ...slot.variants,
                    freshVariant(slot.variants.length)
                  ]
                })
              }
            >
              <Plus /> Add variant
            </Button>
          </CardContent>
        </Card>
      ))}

      <div className="space-y-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setSlots(current => [
              ...(current.length === 1 && current[0].key === "main"
                ? [{ ...current[0], key: "hero" }]
                : current),
              {
                key: `element-${current.length + 1}`,
                variants: [freshVariant(0), freshVariant(1)]
              }
            ])
          }
        >
          <Plus /> Test another element at the same time
        </Button>
        <p className="text-xs text-muted-foreground">
          With several elements (say a hero image AND a call-to-action) the test
          optimizes the combination: one model learns how the elements interact,
          which two separate tests cannot see.
          {multiSlot && ` Currently ${combinations} combinations.`}
        </p>
        {combinations > MAX_CELLS && (
          <p className="text-xs text-destructive">
            {combinations} combinations exceeds the {MAX_CELLS} limit; use fewer
            variants per element.
          </p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Optimization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ctx">Context dimensions (comma-separated)</Label>
            <Input
              id="ctx"
              placeholder="country, device"
              value={ctxKeys}
              onChange={e => setCtxKeys(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Optional. With context, the model can learn a different winner per
              segment. Values are hashed in the visitor's browser.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="redirect">Click redirect URL (optional)</Label>
            <Input
              id="redirect"
              placeholder="https://yoursite.com/thanks"
              value={redirectUrl}
              onChange={e => setRedirectUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Where the click link sends people after counting the click. Only
              the click link needs it, and only when nothing else already says
              where to go: a per-variant destination, or a <code>&amp;r=</code>{" "}
              on the link itself, both count. Leave it empty for an SDK test, or
              when your variants are themselves the destinations.
            </p>
            {needsRedirectUrl && (
              <p className="text-xs text-amber-700 dark:text-amber-500">
                Your variants have destination URLs but no click target. The
                serve link works either way; the click link will refuse until
                one of the three is set, rather than send people nowhere.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="region">Test data location</Label>
            <NativeSelect
              id="region"
              value={region}
              onChange={e => setRegionOverride(e.target.value)}
            >
              <option value="">Wherever the first visitor arrives</option>
              <option value="eu">European Union (guaranteed, GDPR)</option>
              <option value="weur">Western Europe</option>
              <option value="eeur">Eastern Europe</option>
              <option value="wnam">Western North America</option>
              <option value="enam">Eastern North America</option>
              <option value="sam">South America</option>
              <option value="apac">Asia-Pacific</option>
              <option value="oc">Oceania</option>
              <option value="afr">Africa</option>
              <option value="me">Middle East</option>
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              Where the test's counters and model are stored. Defaults to your
              own region: without a choice, storage is created wherever the
              first request comes from, and in email that is often a mail
              provider's US datacenter rather than your audience. "European
              Union" is a hard guarantee (the data never leaves the EU); the
              rest are placement preferences. Part of the test's identity:
              changing it later creates a new test.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rewards">
              Reward events (GA4, comma-separated)
            </Label>
            <Input
              id="rewards"
              placeholder="purchase, sign_up (defaults if empty)"
              value={rewardEvents}
              onChange={e => setRewardEvents(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button size="lg" disabled={busy} onClick={() => void create()}>
        Create test
      </Button>
    </div>
  );
}
