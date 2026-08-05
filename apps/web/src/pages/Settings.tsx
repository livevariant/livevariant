import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, Copy, Globe, KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/lib/account";
import { useServeUrl } from "@/lib/serve-url";

/**
 * Account settings: verified domains (which remove the redirect
 * interstitial and unlock SDK registration) and publishable keys (which
 * let the SDK register tests from those domains). Nothing here exists
 * on a deployment without accounts.
 */

interface DomainRow {
  domain: string;
  verifiedAt: number | null;
  instructions: {
    dnsTxt: { name: string; type: string; value: string };
    wellKnown: { url: string; body: string };
  };
}

interface PkRow {
  key: string;
  label: string | null;
  createdAt: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs break-all">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Copy value"
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
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </span>
  );
}

function SdkSnippet({ pk }: { pk: string }) {
  const serveUrl = useServeUrl();
  const [copied, setCopied] = useState(false);
  const snippet = `import { createTest } from "@livevariant/sdk";

const test = await createTest(
  { slots: { headline: ["Ship faster", "Ship safer"] } },
  {
    serverUrl: "${serveUrl}",
    publishableKey: "${pk}"
  }
);
element.textContent = test.slots.headline.text;`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground flex-1 text-xs">
          Drop this in your page (npm i @livevariant/sdk). Once it is live on
          your homepage, "Check now" above verifies the domain by finding this
          key in the page source.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard
              .writeText(snippet)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {
                // Denied clipboard must not show a green check.
              });
          }}
        >
          {copied ? <Check /> : <Copy />} Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}

export function Settings() {
  const account = useAccount();
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [pks, setPks] = useState<PkRow[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    void fetch("/account/domains", { credentials: "include" })
      .then(res => json<{ domains: DomainRow[] }>(res))
      .then(body => setDomains(body.domains))
      .catch(() => setDomains([]));
    void fetch("/account/publishable-keys", { credentials: "include" })
      .then(res => json<{ keys: PkRow[] }>(res))
      .then(body => setPks(body.keys))
      .catch(() => setPks([]));
  }, []);

  useEffect(() => {
    if (account.ready && account.available && account.me) {
      reload();
    }
  }, [account.ready, account.available, account.me, reload]);

  if (!account.ready) {
    return null;
  }
  if (!account.available) {
    return (
      <p className="text-muted-foreground py-12 text-center">
        This deployment has no accounts.
      </p>
    );
  }
  if (!account.me) {
    return (
      <div className="space-y-4 py-12 text-center">
        <p className="text-muted-foreground">
          Settings need a signed-in account.
        </p>
        <Button asChild>
          <Link to="/login?next=/settings">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>
            <Globe className="mr-1 inline size-5" /> Verified domains
          </CardTitle>
          <CardDescription>
            Verifying a domain proves it is yours: redirects to it skip the
            "Redirecting you to…" screen, and the SDK can register tests served
            from it. Verify with a DNS TXT record, or by serving the well-known
            file, or simply by having the SDK with your publishable key live in
            the page source.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={event => {
              event.preventDefault();
              setBusy(true);
              setNotice(null);
              void fetch("/account/domains", {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ domain: newDomain })
              })
                .then(res => json(res))
                .then(() => {
                  setNewDomain("");
                  reload();
                })
                .catch(err =>
                  setNotice(err instanceof Error ? err.message : String(err))
                )
                .finally(() => setBusy(false));
            }}
          >
            <Input
              value={newDomain}
              onChange={event => setNewDomain(event.target.value)}
              placeholder="example.com"
              className="max-w-xs"
            />
            <Button type="submit" disabled={busy || !newDomain}>
              <Plus /> Add
            </Button>
          </form>
          {notice && <p className="text-destructive text-sm">{notice}</p>}
          {domains.map(row => (
            <div key={row.domain} className="space-y-2 rounded border p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{row.domain}</span>
                {row.verifiedAt ? (
                  <Badge>
                    <Check className="mr-1 size-3" /> verified
                  </Badge>
                ) : (
                  <Badge variant="secondary">pending</Badge>
                )}
                <span className="flex-1" />
                {!row.verifiedAt && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setNotice(null);
                      void fetch(`/account/domains/${row.domain}/verify`, {
                        method: "POST",
                        credentials: "include"
                      })
                        .then(res => json(res))
                        .then(() => reload())
                        .catch(err =>
                          setNotice(
                            err instanceof Error ? err.message : String(err)
                          )
                        );
                    }}
                  >
                    Check now
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.domain}`}
                  onClick={() => {
                    void fetch(`/account/domains/${row.domain}`, {
                      method: "DELETE",
                      credentials: "include"
                    }).then(() => reload());
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              {!row.verifiedAt && (
                <div className="text-muted-foreground space-y-1 text-xs">
                  <p>
                    DNS: add a TXT record at{" "}
                    <CopyValue value={row.instructions.dnsTxt.name} /> with
                    value <CopyValue value={row.instructions.dnsTxt.value} />
                  </p>
                  <p>
                    Or serve{" "}
                    <CopyValue value={row.instructions.wellKnown.url} />{" "}
                    containing{" "}
                    <CopyValue value={row.instructions.wellKnown.body} />
                  </p>
                  <p>
                    Or install the SDK with your publishable key (snippet below)
                    directly in the page source, then Check now.
                  </p>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <KeyRound className="mr-1 inline size-5" /> Publishable keys
          </CardTitle>
          <CardDescription>
            A publishable key is public and safe in page source. Pass it to the
            SDK as <code>publishableKey</code>: tests served from your verified
            domains then appear under My tests automatically. It grants nothing
            else.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="outline"
            onClick={() => {
              void fetch("/account/publishable-keys", {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: "{}"
              })
                .then(res => json(res))
                .then(() => reload());
            }}
          >
            <Plus /> Create key
          </Button>
          {pks.map(row => (
            <div key={row.key} className="space-y-3 rounded border p-3">
              <div className="flex items-center gap-2">
                <CopyValue value={row.key} />
                <span className="text-muted-foreground flex-1 text-xs">
                  created {new Date(row.createdAt).toLocaleDateString()}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete key"
                  onClick={() => {
                    void fetch(`/account/publishable-keys/${row.key}`, {
                      method: "DELETE",
                      credentials: "include"
                    }).then(() => reload());
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              <SdkSnippet pk={row.key} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
