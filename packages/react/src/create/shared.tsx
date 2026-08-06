import { useMemo, useState, type ReactNode } from "react";
import {
  buildTestUrls,
  cellCount,
  MAX_CELLS,
  encodeConfig,
  generateStatsSecret,
  hashStatsSecret,
  type TestConfigInput,
  type TestRegion
} from "@livevariant/core";
import { Button, Card, Field, Input, Select } from "../ui.js";
import type { CreatedTest, TestType } from "../types.js";

/**
 * The parts every flow shares: the basics card (name, server), the
 * audience/region card, and the assemble-encode-finish pipeline. Each
 * flow owns only its variant editor and its install outputs; these
 * hooks keep the three forms from re-implementing the common 80%.
 */

export interface BasicsState {
  name: string;
  setName: (v: string) => void;
  serverUrl: string;
  setServerUrl: (v: string) => void;
  /** Falls back to the deployment default when the field is cleared. */
  effectiveServerUrl: string;
  ctxKeys: string;
  setCtxKeys: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  dims: { key: string }[];
}

export function useBasics(defaults: {
  serverUrl: string;
  region?: string | null;
}): BasicsState {
  const [name, setName] = useState("");
  const [serverOverride, setServerOverride] = useState<string | null>(null);
  const serverUrl = serverOverride ?? defaults.serverUrl;
  const [ctxKeys, setCtxKeys] = useState("");
  const [regionOverride, setRegionOverride] = useState<string | null>(null);
  const region = regionOverride ?? defaults.region ?? "";
  const dims = useMemo(
    () =>
      ctxKeys
        .split(",")
        .map(k => k.trim())
        .filter(Boolean)
        .map(key => ({ key })),
    [ctxKeys]
  );
  return {
    name,
    setName,
    serverUrl,
    setServerUrl: setServerOverride,
    effectiveServerUrl: serverUrl.trim() || defaults.serverUrl,
    ctxKeys,
    setCtxKeys,
    region,
    setRegion: setRegionOverride,
    dims
  };
}

export function BasicsCard({
  basics,
  namePlaceholder
}: {
  basics: BasicsState;
  namePlaceholder: string;
}) {
  return (
    <Card title="Basics">
      <Field label="Test name" htmlFor="lv-name">
        <Input
          id="lv-name"
          placeholder={namePlaceholder}
          value={basics.name}
          onChange={e => basics.setName(e.target.value)}
        />
      </Field>
      <Field
        label="Serving server"
        htmlFor="lv-server"
        hint="The hosted server, or your own (AGPL, self-hostable)."
      >
        <Input
          id="lv-server"
          value={basics.serverUrl}
          onChange={e => basics.setServerUrl(e.target.value)}
        />
      </Field>
    </Card>
  );
}

const REGIONS: [string, string][] = [
  ["", "Wherever the first visitor arrives"],
  ["eu", "European Union (guaranteed, GDPR)"],
  ["weur", "Western Europe"],
  ["eeur", "Eastern Europe"],
  ["wnam", "Western North America"],
  ["enam", "Eastern North America"],
  ["sam", "South America"],
  ["apac", "Asia-Pacific"],
  ["oc", "Oceania"],
  ["afr", "Africa"],
  ["me", "Middle East"]
];

export function AudienceCard({
  basics,
  children
}: {
  basics: BasicsState;
  /** Type-specific extras (reward events, click destination). */
  children?: ReactNode;
}) {
  return (
    <Card title="Audience and data">
      <Field
        label="Context dimensions (comma-separated, optional)"
        htmlFor="lv-ctx"
        hint="With context, the model can learn a different winner per segment. Values are hashed in the visitor's browser."
      >
        <Input
          id="lv-ctx"
          placeholder="country, device"
          value={basics.ctxKeys}
          onChange={e => basics.setCtxKeys(e.target.value)}
        />
      </Field>
      {children}
      <Field
        label="Test data location"
        htmlFor="lv-region"
        hint={
          "Where the test's counters and model live. Defaults to your own region. \"European Union\" is a hard guarantee; the rest are placement preferences. Part of the test's identity."
        }
      >
        <Select
          id="lv-region"
          value={basics.region}
          onChange={e => basics.setRegion(e.target.value)}
        >
          {REGIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
    </Card>
  );
}

/**
 * Assembles the shared config shape, encodes it, and mints the stats
 * secret. Everything happens in the creator's browser: nothing is
 * registered anywhere until the first visitor arrives.
 */
export interface VariantInput {
  name?: string;
  url?: string;
  image?: string;
  text?: string;
}

export async function finishTest(input: {
  type: TestType;
  basics: BasicsState;
  slots: Record<string, VariantInput[]>;
  redirectUrl?: string;
  rewardEvents?: string[];
}): Promise<CreatedTest> {
  const { basics } = input;
  const statsSecret = generateStatsSecret();
  const config: TestConfigInput = {
    v: 2,
    name: basics.name || undefined,
    slots: input.slots,
    ctx: basics.dims.length > 0 ? { dims: basics.dims } : undefined,
    region: basics.region ? (basics.region as TestRegion) : undefined,
    redirectUrl: input.redirectUrl || undefined,
    rewardEvents: input.rewardEvents,
    statsKeyHash: await hashStatsSecret(statsSecret)
  };
  const { encoded, testId, warnings } = await encodeConfig(config);
  const serverUrl = basics.effectiveServerUrl.replace(/\/+$/, "");
  return {
    type: input.type,
    name: basics.name || "Untitled test",
    encoded,
    testId,
    statsSecret,
    serverUrl,
    urls: buildTestUrls(serverUrl, encoded, statsSecret),
    warnings
  };
}

/** The post-create wrapper: type-specific outputs plus the exit button. */
export function InstallStep({
  title,
  children,
  onDone
}: {
  title: string;
  children: ReactNode;
  onDone?: () => void;
}) {
  return (
    <div className="lv-root">
      <Card title={title} description="The test exists. Put it to work:">
        {children}
      </Card>
      {onDone && (
        <Button size="lg" onClick={onDone}>
          View results
        </Button>
      )}
    </div>
  );
}

/** Uploads to the deployment's asset store; returns the protected URL. */
export async function uploadAsset(
  serverUrl: string,
  file: File,
  fetchImpl: typeof globalThis.fetch = fetch
): Promise<string> {
  const res = await fetchImpl(`${serverUrl.replace(/\/+$/, "")}/assets`, {
    method: "POST",
    headers: { "content-type": file.type },
    body: file
  });
  const body = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: string;
  };
  if (!res.ok || !body.url) {
    throw new Error(
      body.error ??
        (res.status === 404
          ? "this server has image hosting disabled"
          : `upload failed (${res.status})`)
    );
  }
  return body.url;
}

/** a..z variant naming, control first; numbers past 26. */
export function variantName(index: number): string {
  return index === 0
    ? "control"
    : `variant-${index < 26 ? String.fromCharCode(96 + index) : index + 1}`;
}

/* ------------------------------------------------------------------ */
/* Elements (slots): shared between every flow that tests one or more
   page/email elements at once. One model optimizes the COMBINATION,
   which is the whole point of multi-element tests; the per-type forms
   differ only in what a variant row edits. */

export interface SlotDraft<V> {
  key: string;
  variants: V[];
}

export interface SlotsState<V> {
  slots: SlotDraft<V>[];
  combinations: number;
  patchSlot(slotIndex: number, part: Partial<SlotDraft<V>>): void;
  patchVariant(slotIndex: number, index: number, part: Partial<V>): void;
  addVariant(slotIndex: number): void;
  removeVariant(slotIndex: number, index: number): void;
  addSlot(): void;
  removeSlot(slotIndex: number): void;
}

export function useSlots<V>(
  freshVariant: (index: number) => V,
  firstKey: string
): SlotsState<V> {
  const [slots, setSlots] = useState<SlotDraft<V>[]>([
    { key: firstKey, variants: [freshVariant(0), freshVariant(1)] }
  ]);
  const patchSlot = (slotIndex: number, part: Partial<SlotDraft<V>>) =>
    setSlots(current =>
      current.map((slot, i) => (i === slotIndex ? { ...slot, ...part } : slot))
    );
  return {
    slots,
    combinations: cellCount(slots.map(slot => slot.variants.length)),
    patchSlot,
    patchVariant: (slotIndex, index, part) =>
      patchSlot(slotIndex, {
        variants: slots[slotIndex].variants.map((v, j) =>
          j === index ? { ...v, ...part } : v
        )
      }),
    addVariant: slotIndex =>
      patchSlot(slotIndex, {
        variants: [
          ...slots[slotIndex].variants,
          freshVariant(slots[slotIndex].variants.length)
        ]
      }),
    removeVariant: (slotIndex, index) =>
      patchSlot(slotIndex, {
        variants: slots[slotIndex].variants.filter((_, j) => j !== index)
      }),
    addSlot: () =>
      setSlots(current => [
        ...current,
        {
          key: `element-${current.length + 1}`,
          variants: [freshVariant(0), freshVariant(1)]
        }
      ]),
    removeSlot: slotIndex =>
      setSlots(current => current.filter((_, j) => j !== slotIndex))
  };
}

/**
 * The element cards plus the "test another element" control. Each
 * variant row gets the shared shell (scoped name, remove) and the
 * flow's own fields through renderVariant.
 */
export function SlotCards<V extends { name: string }>({
  state,
  description,
  singleTitle = "Variants",
  renderVariant
}: {
  state: SlotsState<V>;
  description: string;
  /** Card title while there is only one element. */
  singleTitle?: string;
  renderVariant: (variant: V, slotIndex: number, index: number) => ReactNode;
}) {
  const { slots } = state;
  return (
    <>
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
                    state.patchSlot(slotIndex, {
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
                  onClick={() => state.removeSlot(slotIndex)}
                >
                  Remove
                </Button>
              </span>
            ) : (
              singleTitle
            )
          }
          description={description}
        >
          {slot.variants.map((variant, i) => (
            <div key={i} className="lv-variant-row">
              <div className="lv-row">
                <Input
                  aria-label={`Element ${slotIndex + 1} variant ${i + 1} name`}
                  value={variant.name}
                  onChange={e =>
                    state.patchVariant(slotIndex, i, {
                      name: e.target.value
                    } as Partial<V>)
                  }
                />
                {slot.variants.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remove variant"
                    onClick={() => state.removeVariant(slotIndex, i)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {renderVariant(variant, slotIndex, i)}
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => state.addVariant(slotIndex)}
            >
              Add variant
            </Button>
          </div>
        </Card>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={() => state.addSlot()}>
          Test another element at the same time
        </Button>
        <p className="lv-hint">
          With several elements (a hero AND a call-to-action) one model
          optimizes the combination.
          {slots.length > 1 && ` Currently ${state.combinations} combinations.`}
        </p>
        {state.combinations > MAX_CELLS && (
          <p className="lv-error">
            {state.combinations} combinations exceeds the {MAX_CELLS} limit; use
            fewer variants per element.
          </p>
        )}
      </div>
    </>
  );
}

/** Appends a query pair to a URL that may already carry a query. */
export function withParam(url: string, pair: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${pair}`;
}
