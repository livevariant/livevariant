import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Cloud, Search, Trash2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { loadTests, removeTest } from "@/lib/tests-store";
import {
  claimAndRegister,
  listServerTests,
  useAccount,
  type ServerTest
} from "@/lib/account";

interface Row {
  testId: string;
  name: string;
  createdAt: number | null;
  /** Where this row is known: this browser, the account, or both. */
  local: boolean;
  onAccount: boolean;
}

function merge(
  local: ReturnType<typeof loadTests>,
  server: ServerTest[]
): Row[] {
  const rows = new Map<string, Row>();
  for (const test of server) {
    rows.set(test.testId, {
      testId: test.testId,
      name: test.name ?? "LiveVariant test",
      createdAt: test.addedAt,
      local: false,
      onAccount: true
    });
  }
  for (const test of local) {
    const existing = rows.get(test.testId);
    if (existing) {
      existing.local = true;
      existing.createdAt = test.createdAt;
    } else {
      rows.set(test.testId, {
        testId: test.testId,
        name: test.name,
        createdAt: test.createdAt,
        local: true,
        onAccount: false
      });
    }
  }
  return [...rows.values()].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
  );
}

export function Tests() {
  const account = useAccount();
  const [local, setLocal] = useState(loadTests());
  const [server, setServer] = useState<ServerTest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const signedIn = account.ready && account.available && account.me !== null;

  const loadServer = useCallback(
    (q: string, after?: string) => {
      if (!signedIn) {
        return;
      }
      void listServerTests({ q: q || undefined, cursor: after })
        .then(page => {
          setServer(prev => (after ? [...prev, ...page.tests] : page.tests));
          setCursor(page.nextCursor);
        })
        .catch(() => {
          // An unreachable account list leaves the local list standing.
        });
    },
    [signedIn]
  );

  useEffect(() => {
    loadServer(query);
  }, [loadServer, query]);

  const filteredLocal = query
    ? local.filter(t => t.name.toLowerCase().includes(query.toLowerCase()))
    : local;
  const rows = merge(filteredLocal, server);
  const unsynced = local.filter(t => !server.some(s => s.testId === t.testId));

  if (rows.length === 0 && !query) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="font-display text-3xl">My tests</h1>
        <p className="text-muted-foreground">
          {signedIn
            ? "Nothing here yet."
            : "Nothing here yet. Tests are stored in this browser only."}
        </p>
        <Button asChild>
          <Link to="/builder">Create your first test</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 font-display text-3xl">My tests</h1>
        {signedIn && unsynced.length > 0 && (
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void (async () => {
                for (const test of unsynced) {
                  try {
                    await claimAndRegister({
                      statsSecret: test.statsSecret,
                      encoded: test.encoded,
                      name: test.name
                    });
                  } catch {
                    // A key claimed by someone else stays local; the rest
                    // still sync.
                  }
                }
                loadServer(query);
                setSaving(false);
              })();
            }}
          >
            <UserPlus /> Save {unsynced.length} to my account
          </Button>
        )}
        {account.ready && account.available && !account.me && (
          <Button variant="outline" asChild>
            <Link to="/login?next=/tests">
              Log in or create an account to save your tests
            </Link>
          </Button>
        )}
        <Button asChild>
          <Link to="/builder">Create a test</Link>
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="text-muted-foreground absolute left-2.5 top-2.5 size-4" />
        <Input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search by name"
          className="pl-8"
        />
      </div>

      <div className="space-y-3">
        {rows.map(row => (
          <Card key={row.testId}>
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <div className="flex-1">
                <CardTitle>
                  <Link className="hover:underline" to={`/tests/${row.testId}`}>
                    {row.name}
                  </Link>
                </CardTitle>
                <CardDescription>
                  {row.createdAt
                    ? `created ${new Date(row.createdAt).toLocaleString()}`
                    : "on your account"}
                </CardDescription>
              </div>
              {row.onAccount && (
                <Badge variant="outline" aria-label="Saved to your account">
                  <Cloud className="mr-1 size-3" /> account
                </Badge>
              )}
              <Badge variant="secondary">{row.testId.slice(0, 8)}</Badge>
              {row.local && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Forget test"
                  onClick={() => {
                    removeTest(row.testId);
                    setLocal(loadTests());
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </CardHeader>
          </Card>
        ))}
      </div>
      {cursor && (
        <div className="text-center">
          <Button variant="outline" onClick={() => loadServer(query, cursor)}>
            Load more
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        "Forget" only removes the entry from this browser; the test itself keeps
        working for anyone holding its URLs.
      </p>
    </div>
  );
}
