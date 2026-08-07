import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";
import { Bookmark, Check, Copy, UserPlus } from "lucide-react";
import { buildTestUrls } from "@livevariant/core";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/select";
import { StatsPanel } from "@/components/StatsPanel";
import { claimAndRegister, setActiveOrg, useAccount } from "@/lib/account";
import { useResolvedTest, type ResolvedTest } from "@/lib/resolve-test";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex items-center gap-2">
        {/* A read-only input rather than a <code> block: these URLs are
            longer than the column, and truncated text you cannot scroll
            through is text you cannot check. */}
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={event => event.currentTarget.select()}
          className="flex-1 rounded bg-muted px-2 py-1.5 font-mono text-xs"
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {
                // Denied clipboard must not show a green check.
              });
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The "own this test" surface. Renders nothing on deployments without
 * accounts, which is every self-host without the module: the page then
 * IS the account-free product.
 */
function AccountCard({
  test,
  onSaved
}: {
  test: ResolvedTest;
  onSaved: () => void;
}) {
  const account = useAccount();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetOrg, setTargetOrg] = useState<string | null>(null);

  const orgs = account.me?.orgs ?? [];
  const activeOrgId = account.me?.activeOrgId ?? orgs[0]?.id ?? null;
  const chosenOrg = targetOrg ?? activeOrgId;

  // Claiming is EXPLICIT: with several organizations, an automatic
  // claim would silently pick one of them, and a test filed under the
  // wrong org is worse than one extra click.
  const claim = useCallback(() => {
    if (!test.statsSecret) {
      return;
    }
    setClaiming(true);
    setError(null);
    const switchFirst =
      chosenOrg && chosenOrg !== activeOrgId
        ? setActiveOrg(chosenOrg)
        : Promise.resolve();
    switchFirst
      .then(() =>
        claimAndRegister({
          statsSecret: test.statsSecret!,
          encoded: test.encoded,
          name: test.name
        })
      )
      .then(() => {
        setClaimed(true);
        onSaved();
        account.refresh();
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setClaiming(false));
  }, [test, chosenOrg, activeOrgId, onSaved, account]);

  if (!account.ready || !account.available || !test.statsSecret) {
    return null;
  }
  const next = `/manage/${test.encoded}`;
  const chosenName =
    orgs.find(org => org.id === chosenOrg)?.name ?? "my account";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          A claimed test follows you across browsers, and nobody else can claim
          it. Your stats secret keeps working either way.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {account.me ? (
          claimed ? (
            <p className="text-sm">
              <Check className="mr-1 inline size-4" /> Saved to {chosenName}.
              Find it under <Link to="/tests">My tests</Link>.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {orgs.length > 1 && (
                <NativeSelect
                  value={chosenOrg ?? undefined}
                  aria-label="Organization to add this test to"
                  className="h-9 w-auto max-w-48"
                  onChange={event => setTargetOrg(event.target.value)}
                >
                  {orgs.map(org => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
              <Button disabled={claiming} onClick={claim}>
                <UserPlus />{" "}
                {orgs.length > 1 ? `Add to ${chosenName}` : "Add to my account"}
              </Button>
            </div>
          )
        ) : (
          <Button asChild>
            <Link
              to={`/login?next=${encodeURIComponent(next)}`}
              onClick={onSaved}
            >
              <UserPlus /> Log in or create an account to save your tests
            </Link>
          </Button>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}

export function TestDetail() {
  const params = useParams<{ testId?: string; encoded?: string }>();
  const { test, ready, save } = useResolvedTest(params);
  const [snippetCopied, setSnippetCopied] = useState(false);

  if (!ready) {
    return null;
  }
  if (!test) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-muted-foreground">
          {params.encoded
            ? "That link does not contain a valid test."
            : "This test isn't saved in this browser."}
        </p>
        <Button variant="outline" asChild>
          <Link to="/tests">Back to my tests</Link>
        </Button>
      </div>
    );
  }

  const urls = buildTestUrls(
    test.serveUrl,
    test.encoded,
    test.statsSecret ?? undefined,
    window.location.origin
  );
  // Full encoded config: the snippet must be copy-paste runnable.
  const snippet = `import { createTest } from "@livevariant/sdk";

const test = await createTest(
  "${test.encoded}",
  { serverUrl: "${test.serveUrl}" }
);
element.textContent = test.variant.text;`;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-3xl">{test.name}</h1>
        <div className="ml-auto flex items-center gap-2">
          {!test.saved && test.statsSecret && (
            <Button variant="outline" size="sm" onClick={save}>
              <Bookmark /> Save in this browser
            </Button>
          )}
        </div>
      </div>

      <StatsPanel
        encoded={test.encoded}
        statsSecret={test.statsSecret}
        hasSecret={test.statsSecret !== null}
      />

      <AccountCard test={test} onSaved={save} />

      <Card>
        <CardHeader>
          <CardTitle>URLs</CardTitle>
          <CardDescription>
            Serve goes in your email or link; the pixel goes on the thank-you
            page. The manage URL contains your stats secret in its #fragment:
            share it only with people who may see results.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyField
            label="Serve"
            value={`${urls.serve}?id={{recipient_id}}`}
          />
          <CopyField
            label="Click"
            value={`${urls.click}?id={{recipient_id}}`}
          />
          <CopyField
            label="Pixel"
            value={`${urls.pixel}?id={{recipient_id}}`}
          />
          {test.statsSecret && (
            <CopyField label="Manage (keep private)" value={urls.manage} />
          )}
          <p className="text-muted-foreground pt-1 text-sm">
            If your email carries a tracking image, use the pair below instead.
            The image is fetched by the mail provider, not the reader, and
            whichever request arrives first fixes that recipient's bucket for
            good, so any country the server derives from it belongs to a
            datacenter. These links say so outright rather than leaving it to a
            guess. Context you merge in yourself, like{" "}
            <code>&amp;c_country=nl</code>, still counts.
          </p>
          <CopyField
            label="Serve (no derived context)"
            value={`${urls.noAuto.serve}&id={{recipient_id}}`}
          />
          <CopyField
            label="Click (no derived context)"
            value={`${urls.noAuto.click}&id={{recipient_id}}`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>ESP template</CardTitle>
          <CardDescription>
            The same test written in plain query parameters instead of an
            encoded config, for building a reusable template in your email
            platform. Wire this in once; campaign managers then fill only the
            variant fields through your ordinary template editor and never touch
            this service. Because the variant URLs are part of a test's
            identity, every campaign becomes its own test automatically, and
            this one stats secret opens all of them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {test.statsKeyHash && (
            <>
              <CopyField
                label="Image src (serve)"
                value={`${test.serveUrl}/s?v={{variant_1_url}}&v={{variant_2_url}}&stamp=utm_content&auto=0&id={{recipient_id}}&kh=${test.statsKeyHash}`}
              />
              <CopyField
                label="Link href (click)"
                value={`${test.serveUrl}/c?v={{variant_1_url}}&v={{variant_2_url}}&r={{landing_url}}&stamp=utm_content&auto=0&id={{recipient_id}}&kh=${test.statsKeyHash}`}
              />
            </>
          )}
          <p className="text-muted-foreground text-sm">
            <code>kh</code> is the <em>hash</em> of your stats secret, not the
            secret itself. It is already public in every serve URL, so it is
            safe in a link that reaches every recipient; the secret stays in the
            manage link above.
          </p>
          <p className="text-muted-foreground text-sm">
            Add another <code>v=</code> for a third variant, <code>vn=</code> to
            name them (they default to v1, v2, …), and <code>s=</code> to open a
            second element (<code>s=hero&amp;v=…&amp;s=cta&amp;v=…</code>, each
            link then adding <code>&amp;slot=</code> to say which element it
            serves). <code>stamp=utm_content</code> writes the served variant
            into that parameter on the way out, so the test shows up in your own
            analytics without installing anything; drop it to turn that off. Any
            parameter we do not recognize, <code>utm_source</code> and{" "}
            <code>gclid</code> included, is carried through to the destination,
            and <code>ctx=source:utm_source</code> turns a campaign tag into a
            context dimension the bandit learns per segment.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center space-y-0">
          <CardTitle className="flex-1">SDK snippet</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard
                .writeText(snippet)
                .then(() => {
                  setSnippetCopied(true);
                  setTimeout(() => setSnippetCopied(false), 1500);
                })
                .catch(() => {
                  // Denied clipboard must not show a green check.
                });
            }}
          >
            {snippetCopied ? <Check /> : <Copy />} Copy
          </Button>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
            <code>{snippet}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
