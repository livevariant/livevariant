import { useState } from "react";
import { useSearchParams } from "react-router";
import { Mail } from "lucide-react";
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
import { requestMagicLink, signInWithGoogle } from "@/lib/account";

/**
 * Sign-in: a magic link or Google, nothing else. No passwords exist
 * anywhere in the product, which is one less thing to leak.
 */
export function Login() {
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/tests";
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-md space-y-6 py-12">
      <h1 className="font-display text-3xl">Sign in</h1>
      <Card>
        <CardHeader>
          <CardTitle>Email me a sign-in link</CardTitle>
          <CardDescription>
            No password to invent or remember: the link in your inbox is the
            whole sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sent ? (
            <p className="text-sm">
              <Mail className="mr-1 inline size-4" /> Check your inbox. The link
              signs this browser in and brings you back here.
            </p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={event => {
                event.preventDefault();
                setBusy(true);
                setError(null);
                requestMagicLink(email, next)
                  .then(() => setSent(true))
                  .catch(err =>
                    setError(err instanceof Error ? err.message : String(err))
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <Button type="submit" disabled={busy || !email}>
                Send sign-in link
              </Button>
            </form>
          )}
          <div className="border-t pt-4">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setError(null);
                void signInWithGoogle(next).catch(err =>
                  setError(err instanceof Error ? err.message : String(err))
                );
              }}
            >
              Continue with Google
            </Button>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
