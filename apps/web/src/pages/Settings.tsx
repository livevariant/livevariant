import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  Check,
  Copy,
  Globe,
  KeyRound,
  Plus,
  Trash2,
  Users,
  X
} from "lucide-react";
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
import { NativeSelect } from "@/components/ui/select";
import {
  cancelInvitation,
  createOrg,
  fullOrganization,
  inviteMember,
  leaveOrg,
  setActiveOrg,
  useAccount,
  type AccountState,
  type FullOrganization
} from "@/lib/account";
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

function Snippet({ intro, code }: { intro: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-muted-foreground flex-1 text-xs">{intro}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard
              .writeText(code)
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
        <code>{code}</code>
      </pre>
    </div>
  );
}

function SdkSnippet({ pk }: { pk: string }) {
  const serveUrl = useServeUrl();
  return (
    <div className="space-y-4">
      <Snippet
        intro={
          "The tag, in <head>. On its own it already tracks conversions " +
          "for this visitor's redirect and email tests, sets the page-wide " +
          'config, and (once live on your homepage) lets "Check now" above ' +
          "verify the domain."
        }
        code={`<script defer src="${serveUrl}/sdk.js"
        data-publishable-key="${pk}"></script>`}
      />
      <p className="text-muted-foreground text-xs">
        Adding it through Google Tag Manager instead? Use a Custom HTML tag with
        this same snippet and tick "Support document.write" in the tag settings;
        verification then needs the rendered check (automatic on the hosted
        service) since GTM tags never appear in raw HTML.
      </p>
      <Snippet
        intro={
          "Then testing on-page content needs only the test itself: with " +
          "the tag installed, createTest reads the server and key from the " +
          "page config (or pass them explicitly with npm i @livevariant/sdk)."
        }
        code={`const test = await window.livevariant.sdk.createTest({
  slots: { headline: ["Ship faster", "Ship safer"] }
});
element.textContent = test.slots.headline.text;`}
      />
    </div>
  );
}

function OrganizationCard({ account }: { account: AccountState }) {
  const [org, setOrg] = useState<FullOrganization | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const activeOrgId = account.me?.activeOrgId ?? account.me?.orgs[0]?.id;

  const reload = useCallback(() => {
    if (!activeOrgId) {
      setOrg(null);
      return;
    }
    void fullOrganization(activeOrgId)
      .then(setOrg)
      .catch(() => setOrg(null));
  }, [activeOrgId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const surface = (err: unknown) =>
    setNotice(err instanceof Error ? err.message : String(err));

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Users className="mr-1 inline size-5" /> Organization
          {org ? `: ${org.name}` : ""}
        </CardTitle>
        <CardDescription>
          Tests, keys and verified domains belong to an organization, and
          everything you do here acts on the active one (switch in the header).
          You can belong to as many as you are invited to.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {org && (
          <>
            <div className="space-y-1">
              {org.members.map(member => (
                <div
                  key={member.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="flex-1">
                    {member.user.name || member.user.email}
                    <span className="text-muted-foreground">
                      {" "}
                      · {member.user.email}
                    </span>
                  </span>
                  <Badge variant="secondary">{member.role}</Badge>
                </div>
              ))}
            </div>
            {org.invitations.filter(inv => inv.status === "pending").length >
              0 && (
              <div className="space-y-1">
                {org.invitations
                  .filter(inv => inv.status === "pending")
                  .map(inv => (
                    <div
                      key={inv.id}
                      className="text-muted-foreground flex items-center gap-2 text-sm"
                    >
                      <span className="flex-1">
                        {inv.email} · invited as {inv.role ?? "member"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Cancel invitation for ${inv.email}`}
                        onClick={() => {
                          setNotice(null);
                          void cancelInvitation(inv.id)
                            .then(reload)
                            .catch(surface);
                        }}
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
              </div>
            )}
            <form
              className="flex flex-wrap gap-2"
              onSubmit={event => {
                event.preventDefault();
                setNotice(null);
                void inviteMember({ email: inviteEmail, role: inviteRole })
                  .then(() => {
                    setInviteEmail("");
                    reload();
                  })
                  .catch(surface);
              }}
            >
              <Input
                type="email"
                value={inviteEmail}
                onChange={event => setInviteEmail(event.target.value)}
                placeholder="teammate@example.com"
                className="max-w-xs"
                aria-label="Invite email"
              />
              <NativeSelect
                value={inviteRole}
                aria-label="Invite role"
                className="h-9 w-auto"
                onChange={event =>
                  setInviteRole(event.target.value as "member" | "admin")
                }
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </NativeSelect>
              <Button type="submit" disabled={!inviteEmail}>
                <Plus /> Invite
              </Button>
            </form>
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Input
            value={newOrgName}
            onChange={event => setNewOrgName(event.target.value)}
            placeholder="New organization name"
            className="max-w-xs"
            aria-label="New organization name"
          />
          <Button
            variant="outline"
            disabled={creating || !newOrgName}
            onClick={() => {
              setCreating(true);
              setNotice(null);
              void createOrg(newOrgName)
                .then(created =>
                  setActiveOrg(created.id).then(() => {
                    window.location.reload();
                  })
                )
                .catch(err => {
                  surface(err);
                  setCreating(false);
                });
            }}
          >
            <Plus /> Create organization
          </Button>
          {(account.me?.orgs.length ?? 0) > 1 && activeOrgId && (
            <Button
              variant="ghost"
              onClick={() => {
                setNotice(null);
                void leaveOrg(activeOrgId)
                  .then(() => {
                    window.location.reload();
                  })
                  .catch(surface);
              }}
            >
              Leave this organization
            </Button>
          )}
        </div>
        {notice && <p className="text-destructive text-sm">{notice}</p>}
      </CardContent>
    </Card>
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

      <OrganizationCard account={account} />

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
                        .then(res =>
                          json<{ verified: boolean; reason?: string }>(res)
                        )
                        .then(result => {
                          if (!result.verified) {
                            setNotice(
                              result.reason ??
                                "Not verified yet: publish one of the records below and check again."
                            );
                          }
                          reload();
                        })
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
                    Or install the SDK with your publishable key (snippet
                    below), then Check now. Tag-manager installs count too: the
                    check renders the page before looking.
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
