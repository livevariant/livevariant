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
import {
  registerWithPassword,
  requestMagicLink,
  signInWithPassword
} from "@/lib/account";

/**
 * Sign-in and registration: email plus password, with a magic link as
 * the no-password alternative. One page, one toggle, no separate
 * register route to get lost on.
 */
export function Login() {
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/tests";
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setBusy(true);
    setError(null);
    if (mode === "register") {
      // Registration is not done until the address is verified, so
      // there is no session to redirect with yet: the next step is the
      // inbox.
      registerWithPassword({ email, password })
        .then(() => setVerifySent(true))
        .catch(err => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(false));
      return;
    }
    signInWithPassword({ email, password })
      .then(() => {
        // A full navigation, not a client-side one: AppLayout's account
        // state must re-read the fresh session cookie.
        window.location.href = next;
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  };

  return (
    <div className="mx-auto max-w-md space-y-6 py-12">
      <h1 className="font-display text-3xl">
        {mode === "register" ? "Create an account" : "Sign in"}
      </h1>
      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "register" ? "Register with email" : "Email and password"}
          </CardTitle>
          <CardDescription>
            {mode === "register"
              ? "Your tests follow your account across browsers, and nobody else can claim them."
              : "Welcome back."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {verifySent ? (
            <p className="text-sm">
              <Mail className="mr-1 inline size-4" /> Almost there: we sent a
              verification link to {email}. Click it, then sign in.
            </p>
          ) : (
            <>
              <form
                className="space-y-4"
                onSubmit={event => {
                  event.preventDefault();
                  submit();
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
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    placeholder={
                      mode === "register" ? "at least 8 characters" : "password"
                    }
                  />
                </div>
                <Button type="submit" disabled={busy || !email || !password}>
                  {mode === "register" ? "Create account" : "Sign in"}
                </Button>
              </form>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-sm underline"
                onClick={() => {
                  setMode(mode === "register" ? "signin" : "register");
                  setError(null);
                }}
              >
                {mode === "register"
                  ? "Already have an account? Sign in"
                  : "No account yet? Create one"}
              </button>
            </>
          )}
          <div className="border-t pt-4">
            {linkSent ? (
              <p className="text-sm">
                <Mail className="mr-1 inline size-4" /> Check your inbox. The
                link signs this browser in and brings you back here.
              </p>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  // Never disabled: people click the alternative FIRST,
                  // and a dead-looking button explains nothing. Missing
                  // email routes them to the field instead.
                  if (!email) {
                    setError("Enter your email above first.");
                    document.getElementById("email")?.focus();
                    return;
                  }
                  setError(null);
                  requestMagicLink(email, next)
                    .then(() => setLinkSent(true))
                    .catch(err =>
                      setError(err instanceof Error ? err.message : String(err))
                    );
                }}
              >
                <Mail /> Email me a sign-in link instead
              </Button>
            )}
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
