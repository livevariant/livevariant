import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CreateTest, Snippet, type TestType } from "@livevariant/react";
import "@livevariant/react/styles.css";
import { useAccount } from "@/lib/account";
import { saveTest } from "@/lib/tests-store";
import { useDeploymentConfig } from "@/lib/serve-url";
import { InstallCard } from "@/components/InstallCard";

/**
 * The create page: a thin host around @livevariant/react's CreateTest.
 * This page owns what a generic embed cannot: the deployment's serving
 * defaults, the signed-in account's publishable keys, browser-side
 * persistence, and where to go next.
 */
export function Builder() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const deployment = useDeploymentConfig();
  const account = useAccount();
  const [publishableKeys, setPublishableKeys] = useState<string[]>([]);

  const userId = account.me?.userId ?? null;
  useEffect(() => {
    if (!userId) {
      setPublishableKeys([]);
      return;
    }
    let live = true;
    void fetch("/account/publishable-keys", { credentials: "include" })
      .then(res => (res.ok ? res.json() : { keys: [] }))
      .then((body: { keys?: { key: string }[] }) => {
        if (live) {
          setPublishableKeys((body.keys ?? []).map(k => k.key));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [userId]);

  const requestedType = params.get("type");
  const defaultType = (["email", "redirect", "website"] as const).find(
    t => t === requestedType
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-3xl">Create a test</h1>
        <p className="text-sm text-muted-foreground">
          Everything is built in your browser: the config becomes a URL, the
          stats secret stays with you, and nothing is registered anywhere until
          the first visitor arrives.
        </p>
      </div>
      <CreateTest
        serverUrl={deployment.serveUrl}
        region={deployment.region}
        defaultType={defaultType as TestType | undefined}
        publishableKeys={publishableKeys}
        verifyDomainsHref="/settings"
        llmContent={
          <div className="space-y-4">
            <InstallCard />
            {publishableKeys[0] ? (
              <div className="rounded-lg border border-border bg-card p-4">
                <Snippet
                  intro={
                    "Then just ask. Your publishable key is prefilled " +
                    "(it is public and safe to share with your agent); " +
                    "registering makes the test appear under My tests:"
                  }
                  code={
                    "Create a LiveVariant A/B test for my [newsletter " +
                    "hero / landing page / homepage headline]: test " +
                    "[describe the variants, or ask it to draft them]. " +
                    "If images are needed and I have none, generate " +
                    "on-brand variants yourself. Register the test to " +
                    `my account with publishable key ${publishableKeys[0]} ` +
                    "and hand back the ready-to-paste snippet plus the " +
                    "manage link."
                  }
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {account.me
                  ? "Create a publishable key in "
                  : "Sign in and create a publishable key in "}
                <Link className="underline" to="/settings">
                  Settings
                </Link>{" "}
                to get a copy-paste prompt with your key prefilled; your
                assistant can then register tests straight into your account.
                Without one, it hands back a manage link you open to save the
                test.
              </p>
            )}
          </div>
        }
        onCreated={test => {
          saveTest({
            name: test.name,
            encoded: test.encoded,
            testId: test.testId,
            statsSecret: test.statsSecret,
            serverUrl: test.serverUrl,
            createdAt: Date.now(),
            type: test.type
          });
          if (test.warnings.length > 0) {
            console.warn(test.warnings.join("\n"));
          }
        }}
        onDone={test => navigate(`/tests/${test.testId}`)}
      />
    </div>
  );
}
