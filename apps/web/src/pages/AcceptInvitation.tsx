import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Check, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  acceptInvitation,
  getInvitation,
  setActiveOrg,
  useAccount,
  type InvitationDetails
} from "@/lib/account";

/**
 * The landing page of an invitation email. Signed out it routes
 * through login and returns; signed in it names the organization and
 * accepts on an explicit click, then makes the new org active, since
 * joining it was the whole point of the visit.
 */
export function AcceptInvitation() {
  const { id } = useParams<{ id: string }>();
  const account = useAccount();
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  // Depends on the userId PRIMITIVE, not the account.me object: refresh()
  // recreates the object, and an object dependency made this loader
  // refire after acceptance, refetching the consumed invitation and
  // painting "not found" over a join that had just succeeded.
  const userId = account.me?.userId ?? null;
  useEffect(() => {
    if (!id || !account.ready || !account.available || !userId || accepted) {
      return;
    }
    let live = true;
    getInvitation(id)
      .then(details => {
        if (live) {
          setInvitation(details);
        }
      })
      .catch(err => {
        if (live) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      live = false;
    };
  }, [id, account.ready, account.available, userId, accepted]);

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
          Sign in with the invited email address to accept this invitation.
        </p>
        <Button asChild>
          <Link
            to={`/login?next=${encodeURIComponent(`/accept-invitation/${id}`)}`}
          >
            Sign in to continue
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>
            <Users className="mr-1 inline size-5" /> Organization invitation
          </CardTitle>
          <CardDescription>
            {invitation
              ? `You are invited to join ${invitation.organizationName} as ${invitation.role ?? "member"}.`
              : error
                ? "This invitation could not be loaded."
                : "Loading the invitation…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {accepted ? (
            <p className="text-sm">
              <Check className="mr-1 inline size-4" /> You joined{" "}
              {invitation?.organizationName}. It is now your active
              organization: head to <Link to="/tests">My tests</Link>.
            </p>
          ) : (
            invitation && (
              <Button
                disabled={busy}
                onClick={() => {
                  if (!id) {
                    return;
                  }
                  setBusy(true);
                  setError(null);
                  acceptInvitation(id)
                    .then(() =>
                      invitation.organizationId
                        ? setActiveOrg(invitation.organizationId)
                        : Promise.resolve()
                    )
                    .then(() => {
                      setAccepted(true);
                      account.refresh();
                    })
                    .catch(err => {
                      setError(
                        err instanceof Error ? err.message : String(err)
                      );
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Join {invitation.organizationName}
              </Button>
            )
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
