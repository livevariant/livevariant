import { Link } from "react-router";

/**
 * Privacy policy for the HOSTED service. The honest headline is that
 * the architecture already minimizes what we could know: identities
 * are hashed per test before they reach the server, and self-hosting
 * takes us out of the picture entirely.
 */

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-display text-xl">{title}</h2>
      {children}
    </section>
  );
}

export function Privacy() {
  return (
    <div className="mx-auto max-w-2xl space-y-8 py-10 text-sm leading-relaxed">
      <div>
        <h1 className="font-display text-3xl">Privacy Policy</h1>
        <p className="mt-2 text-muted-foreground">
          Last updated: August 6, 2026. This policy covers the hosted service at
          livevariant.com and livevariant.link. If you use LiveVariant on
          someone else's deployment, their policy applies, not this one; if you
          run your own deployment, none of your data passes through us at all.
        </p>
      </div>

      <Section title="1. The short version">
        <p>
          We store what the product needs and nothing else: your account email,
          the tests you create, and per-test aggregate statistics. Raw visitor
          identifiers and raw context values never reach our servers: they are
          hashed in the browser (or by your email tool's merge tags) before any
          request is made. We build no cross-test or cross-site profiles, and
          the hashing exists precisely to make that impossible.
        </p>
      </Section>

      <Section title="2. Account holders">
        <p>
          Creating an account stores your email address, optional name,
          organization membership, and (for password sign-in) a salted password
          hash. Sign-in, verification, and invitation emails are delivered
          through Resend (resend.com), our email processor. We send no marketing
          email.
        </p>
      </Section>

      <Section title="3. Tests and their statistics">
        <p>
          A test's configuration (variants, images, destinations) is stored so
          it can be served, along with its statistics: assignment and conversion
          counts per variant and per audience segment. Identities in those
          records are one-way hashes scoped to a single test, so records from
          different tests cannot be joined into a profile. Traffic-source
          records rotate daily and never contain addresses.
        </p>
      </Section>

      <Section title="4. Visitors of tests">
        <p>
          When you visit a page, email, or link that uses a LiveVariant test, we
          process on behalf of the test's creator: a hashed identifier (so you
          keep seeing the same variant), coarse request context such as country
          and device class where the test uses it, and conversion events. The
          serving domain may set one first-party cookie (lv_uid, 180 days) on
          real page visits so that a shared test link stays consistent for you
          across visits. It is never set for images fetched by email providers,
          it is hashed per test before storage, and deployments can disable it
          entirely. We do not use third-party advertising or tracking cookies.
        </p>
      </Section>

      <Section title="5. Cookies on this dashboard">
        <p>
          Signing in sets session cookies scoped to this site. The public site
          may also load Google Tag Manager for our own basic analytics; it is
          not loaded inside tests you create for your visitors.
        </p>
      </Section>

      <Section title="6. Where data lives">
        <p>
          The service runs on Cloudflare's global network. A test's counters and
          model live where its region setting says: the European Union option is
          a hard guarantee that its data never leaves the EU, the other options
          are placement preferences, and without a choice data is created where
          the first request arrives.
        </p>
      </Section>

      <Section title="7. Retention and deletion">
        <p>
          Tests and their statistics live until you delete them or until we
          remove them (see the{" "}
          <Link className="underline" to="/terms">
            Terms
          </Link>{" "}
          on retention: the hosted service makes no retention promise). For
          account deletion or data requests, email{" "}
          <a className="underline" href="mailto:hi@livevariant.com">
            hi@livevariant.com
          </a>
          .
        </p>
      </Section>

      <Section title="8. Your rights">
        <p>
          Depending on where you live (for example under the GDPR), you may have
          rights to access, correct, export, or erase personal data, and to
          object to processing. Write to{" "}
          <a className="underline" href="mailto:hi@livevariant.com">
            hi@livevariant.com
          </a>{" "}
          and we will handle it; you can also complain to your local data
          protection authority.
        </p>
      </Section>

      <Section title="9. Changes">
        <p>We may update this policy; the date above changes when we do.</p>
      </Section>

      <Section title="10. Contact">
        <p>
          LiveVariant,{" "}
          <a className="underline" href="mailto:hi@livevariant.com">
            hi@livevariant.com
          </a>
          .
        </p>
      </Section>
    </div>
  );
}
