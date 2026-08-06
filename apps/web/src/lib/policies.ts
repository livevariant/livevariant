/**
 * Whether the hosted service's Terms and Privacy pages apply to THIS
 * deployment. They are livevariant.com's policies, and a self-hosted
 * dashboard must not ask its users to agree to someone else's terms:
 * there, the links and the signup agreement disappear (the routes stay,
 * and the pages themselves say whose service they cover). localhost
 * counts as hosted so development exercises the real signup flow.
 */
export function hostedPoliciesApply(
  hostname: string = window.location.hostname
): boolean {
  return (
    hostname === "livevariant.com" ||
    hostname === "www.livevariant.com" ||
    hostname === "livevariant.link" ||
    hostname === "localhost"
  );
}
