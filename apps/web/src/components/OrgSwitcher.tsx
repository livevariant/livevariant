import { NativeSelect } from "@/components/ui/select";
import { setActiveOrg, type AccountState } from "@/lib/account";

/**
 * The header's organization switcher. One membership renders as plain
 * text (nothing to switch); several render a select whose choice sets
 * the session's active organization, which is what every /account list
 * and claim acts on. A full reload follows: simpler and more honest
 * than chasing every piece of per-org state through the app.
 */
export function OrgSwitcher({
  account,
  onSwitched = () => window.location.reload()
}: {
  account: AccountState;
  /** Injectable for tests; the default full reload is the real UX. */
  onSwitched?: () => void;
}) {
  if (!account.ready || !account.available || !account.me) {
    return null;
  }
  const orgs = account.me.orgs;
  if (orgs.length === 0) {
    return null;
  }
  if (orgs.length === 1) {
    return (
      <span className="text-muted-foreground max-w-32 truncate text-sm">
        {orgs[0].name}
      </span>
    );
  }
  const active = account.me.activeOrgId ?? orgs[0].id;
  return (
    <NativeSelect
      value={active}
      aria-label="Switch organization"
      className="h-8 w-auto max-w-40"
      onChange={event => {
        void setActiveOrg(event.target.value).then(onSwitched);
      }}
    >
      {orgs.map(org => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </NativeSelect>
  );
}
