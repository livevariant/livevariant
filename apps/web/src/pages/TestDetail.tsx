import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Check, Copy, RefreshCw } from "lucide-react";
import { buildTestUrls, hashStatsSecret } from "@livevariant/core";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { loadTests } from "@/lib/tests-store";

interface ArmStats {
  name?: string;
  pulls: number;
  conversions: number;
  rewardTotal: number;
  conversionRate: number | null;
}

interface Stats {
  alg: string;
  totalAssignments: number;
  arms: ArmStats[];
  buckets: Record<string, unknown>;
}

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
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

export function TestDetail() {
  const { testId } = useParams<{ testId: string }>();
  const test = useMemo(
    () => loadTests().find(t => t.testId === testId),
    [testId]
  );
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  // The stats key is the one fixed part of an ESP template: set it once
  // and every campaign built from the template is readable with the same
  // secret, while each one is still its own test.
  const [statsKeyHash, setStatsKeyHash] = useState<string | null>(null);

  useEffect(() => {
    if (!test) {
      return;
    }
    let live = true;
    void hashStatsSecret(test.statsSecret).then(hash => {
      if (live) {
        setStatsKeyHash(hash);
      }
    });
    return () => {
      live = false;
    };
  }, [test]);

  const refresh = useCallback(async () => {
    if (!test) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${test.serverUrl}/stats/${test.encoded}`, {
        headers: { authorization: `Bearer ${test.statsSecret}` }
      });
      if (!res.ok) {
        throw new Error(`stats request failed (${res.status})`);
      }
      setStats((await res.json()) as Stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [test]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!test) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-muted-foreground">
          This test isn't saved in this browser.
        </p>
        <Button variant="outline" asChild>
          <Link to="/tests">Back to my tests</Link>
        </Button>
      </div>
    );
  }

  const urls = buildTestUrls(test.serverUrl, test.encoded, test.statsSecret);
  // Full encoded config: the snippet must be copy-paste runnable.
  const snippet = `import { createTest } from "@livevariant/sdk";

const test = await createTest(
  "${test.encoded}",
  { serverUrl: "${test.serverUrl}" }
);
element.textContent = test.variant.text;`;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{test.name}</h1>
        {stats && <Badge variant="secondary">{stats.alg}</Badge>}
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
          <CardDescription>
            {stats
              ? `${stats.totalAssignments} assignments · ${Object.keys(stats.buckets).length} context buckets`
              : error
                ? `Could not load stats: ${error}`
                : "loading…"}
          </CardDescription>
        </CardHeader>
        {stats && (
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 font-medium">Variant</th>
                  <th className="py-2 font-medium">Pulls</th>
                  <th className="py-2 font-medium">Conversions</th>
                  <th className="py-2 font-medium">Rate</th>
                  <th className="py-2 font-medium">Reward</th>
                </tr>
              </thead>
              <tbody>
                {stats.arms.map((arm, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2">{arm.name ?? `arm ${i}`}</td>
                    <td className="py-2">{arm.pulls}</td>
                    <td className="py-2">{arm.conversions}</td>
                    <td className="py-2">
                      {arm.conversionRate === null
                        ? "–"
                        : `${(arm.conversionRate * 100).toFixed(1)}%`}
                    </td>
                    <td className="py-2">{arm.rewardTotal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        )}
      </Card>

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
          <CopyField label="Manage (keep private)" value={urls.manage} />
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
          {statsKeyHash && (
            <>
              <CopyField
                label="Image src (serve)"
                value={`${test.serverUrl}/s?v={{variant_1_url}}&v={{variant_2_url}}&kh=${statsKeyHash}&stamp=utm_content&auto=0&id={{recipient_id}}`}
              />
              <CopyField
                label="Link href (click)"
                value={`${test.serverUrl}/c?v={{variant_1_url}}&v={{variant_2_url}}&r={{landing_url}}&kh=${statsKeyHash}&stamp=utm_content&auto=0&id={{recipient_id}}`}
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
            Add another <code>v=</code> for a third variant, and{" "}
            <code>vn=</code> to name them (they default to v1, v2, …).{" "}
            <code>stamp=utm_content</code> writes the served variant into that
            parameter on the way out, so the test shows up in your own analytics
            without installing anything; drop it to turn that off. Any parameter
            we do not recognize, <code>utm_source</code> and <code>gclid</code>{" "}
            included, is carried through to the destination, and{" "}
            <code>ctx=source:utm_source</code> turns a campaign tag into a
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
              void navigator.clipboard.writeText(snippet);
              setSnippetCopied(true);
              setTimeout(() => setSnippetCopied(false), 1500);
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
