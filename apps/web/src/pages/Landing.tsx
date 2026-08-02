import { Link } from "react-router";
import { ArrowRight, Link2, Lock, Sparkles, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from "@/components/ui/card";
import { DEFAULT_SERVER_URL } from "@/lib/tests-store";

export function Landing() {
  return (
    <div className="space-y-16">
      <section className="space-y-6 pt-8 text-center">
        <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          A/B testing without the platform
        </h1>
        <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
          Your variants compete live. Bandit algorithms shift traffic toward the
          winner while the test runs, and the entire test lives in a URL: no
          account, no snippet configuration, no user data stored.
        </p>
        <div className="flex justify-center gap-3">
          <Button size="lg" asChild>
            <Link to="/builder">
              Create a test <ArrowRight />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <a href="https://github.com/livevariant/livevariant">
              Read the source
            </a>
          </Button>
        </div>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <TrendingUp className="size-6" />
            <CardTitle>Live optimization, not a frozen split</CardTitle>
            <CardDescription>
              Thompson sampling sends more traffic to the winning variant as
              evidence accumulates, instead of waiting weeks for a 50/50 test to
              reach significance. Contextual modes learn a different winner per
              country, device, or persona.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <Link2 className="size-6" />
            <CardTitle>The URL is the test</CardTitle>
            <CardDescription>
              Variants, algorithm, and priors are encoded into the serve URL
              itself. Works in emails (sticky per recipient across opens),
              landing-page redirects, or inline on your site via a 2&nbsp;KB
              SDK.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <Lock className="size-6" />
            <CardTitle>Verifiably private</CardTitle>
            <CardDescription>
              The server stores opaque hashes and counters: never variant
              content, raw user ids, or raw context values. The code is AGPL, so
              the claim is auditable, not marketing.
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <Sparkles className="size-6" />
            <CardTitle>Warm-started by your LLM</CardTitle>
            <CardDescription>
              Coming next: an MCP server will let Claude or any LLM draft
              variants and encode its win-probability guesses as capped priors,
              so small tests start smart and real data always has the last word.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">On your site in three lines</h2>
        <Card>
          <CardContent className="pt-6">
            <pre className="overflow-x-auto text-sm">
              <code>{`import { createTest } from "@livevariant/sdk";

const test = await createTest("<encoded-config>", {
  serverUrl: "${DEFAULT_SERVER_URL}"
});
headline.textContent = test.variant.text;
// conversions auto-tracked from your existing GA events`}</code>
            </pre>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
