import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Plus, Trash2, Wand2 } from "lucide-react";
import {
  encodeConfig,
  generateStatsSecret,
  hashStatsSecret,
  recommendAlgorithm,
  type TestConfigInput
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
import { useServeUrl } from "@/lib/serve-url";

interface ArmDraft {
  name: string;
  url: string;
  image: string;
  text: string;
  uploading?: boolean;
  uploadError?: string;
}

export function Builder() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  // Detected from the deployment, until the person types their own.
  const detectedServerUrl = useServeUrl();
  const [serverOverride, setServerOverride] = useState<string | null>(null);
  const serverUrl = serverOverride ?? detectedServerUrl;
  // Guarded at use, not in the change handler: an empty field has to stay
  // empty while someone clears it to type a new one, but an empty serving
  // origin would build relative URLs that serve nothing.
  const effectiveServerUrl = serverUrl.trim() || detectedServerUrl;
  const [arms, setArms] = useState<ArmDraft[]>([
    { name: "control", url: "", image: "", text: "" },
    { name: "variant-b", url: "", image: "", text: "" }
  ]);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [ctxKeys, setCtxKeys] = useState("");
  const [alg, setAlg] = useState<"auto" | "ts" | "bucketed" | "linear">("auto");
  const [rewardEvents, setRewardEvents] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The exact condition the click endpoint enforces: it needs ?to=, a
  // per-variant redirectUrl, or this one. Variants with a destination are
  // the case where someone is likely to want click tracking and be
  // surprised by a 400 in the middle of a campaign.
  const needsRedirectUrl =
    redirectUrl.trim() === "" && arms.some(arm => arm.url.trim() !== "");

  const dims = useMemo(
    () =>
      ctxKeys
        .split(",")
        .map(k => k.trim())
        .filter(Boolean)
        .map(key => ({ key })),
    [ctxKeys]
  );
  const recommendation = useMemo(
    () => recommendAlgorithm({ ctxDims: dims }),
    [dims]
  );
  const effectiveAlg = alg === "auto" ? recommendation.alg : alg;

  /**
   * Uploads to the deployment's asset store and drops the returned
   * protected URL into the image field. The URL 403s outside a test's
   * serving flow, which is the point: hosting here is for variants, not
   * for hotlinking.
   */
  async function uploadImage(index: number, file: File) {
    setArm(index, { uploading: true, uploadError: undefined });
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
      setArm(index, { image: body.url, uploading: false });
    } catch (err) {
      setArm(index, {
        uploading: false,
        uploadError: err instanceof Error ? err.message : String(err)
      });
    }
  }

  function setArm(index: number, patch: Partial<ArmDraft>) {
    setArms(current =>
      current.map((arm, i) => (i === index ? { ...arm, ...patch } : arm))
    );
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const statsSecret = generateStatsSecret();
      const config: TestConfigInput = {
        v: 1,
        name: name || undefined,
        arms: arms.map(arm => ({
          name: arm.name,
          formats: {
            url: arm.url || undefined,
            image: arm.image || undefined,
            text: arm.text || undefined
          }
        })),
        alg: effectiveAlg,
        ctx: dims.length > 0 ? { dims } : undefined,
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
          stats secret stays with you, and nothing is registered anywhere.
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

      <Card>
        <CardHeader>
          <CardTitle>Variants</CardTitle>
          <CardDescription>
            Give each variant a destination URL (email/redirect tests), inline
            text (SDK tests), or both.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {arms.map((arm, i) => (
            <div key={i} className="space-y-2 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Variant ${i + 1} name`}
                  className="max-w-48"
                  value={arm.name}
                  onChange={e => setArm(i, { name: e.target.value })}
                />
                {arms.length > 2 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove variant"
                    onClick={() =>
                      setArms(current => current.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
              <Input
                placeholder="Destination URL (https://…)"
                value={arm.url}
                onChange={e => setArm(i, { url: e.target.value })}
              />
              <Input
                placeholder="Inline text (for SDK serving)"
                value={arm.text}
                onChange={e => setArm(i, { text: e.target.value })}
              />
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Image URL (email tests)"
                  value={arm.image}
                  onChange={e => setArm(i, { image: e.target.value })}
                />
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                  className="hidden"
                  id={`arm-${i}-upload`}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) {
                      void uploadImage(i, file);
                    }
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={arm.uploading}
                  onClick={() =>
                    document.getElementById(`arm-${i}-upload`)?.click()
                  }
                >
                  {arm.uploading ? "Uploading…" : "Upload"}
                </Button>
              </div>
              {arm.uploadError && (
                <p className="text-xs text-red-600">{arm.uploadError}</p>
              )}
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setArms(current => [
                ...current,
                {
                  image: "",
                  // a..z, then plain numbers past 26 variants.
                  name: `variant-${
                    current.length < 26
                      ? String.fromCharCode(97 + current.length)
                      : current.length + 1
                  }`,
                  url: "",
                  text: ""
                }
              ])
            }
          >
            <Plus /> Add variant
          </Button>
        </CardContent>
      </Card>

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
              Optional. With context, the bandit can learn a different winner
              per segment. Values are hashed in the visitor's browser.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="alg">Algorithm</Label>
            <NativeSelect
              id="alg"
              value={alg}
              onChange={e => setAlg(e.target.value as typeof alg)}
            >
              <option value="auto">Auto ({recommendation.alg})</option>
              <option value="ts">Thompson sampling</option>
              <option value="bucketed">Bucketed Thompson</option>
              <option value="linear">Linear Thompson (contextual)</option>
            </NativeSelect>
            {alg === "auto" && (
              <p className="flex items-start gap-1 text-xs text-muted-foreground">
                <Wand2 className="mt-0.5 size-3 shrink-0" />
                {recommendation.reasoning}
              </p>
            )}
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
