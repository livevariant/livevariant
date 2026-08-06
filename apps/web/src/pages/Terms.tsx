import { Link } from "react-router";

/**
 * Terms for the HOSTED service. The framing mirrors the AGPL license
 * the software ships under: the intended way to run LiveVariant is
 * your own deployment, the hosted service is a convenience offered as
 * is, and the warranty/liability language below is adapted from the
 * license's own sections 15 and 16.
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

export function Terms() {
  return (
    <div className="mx-auto max-w-2xl space-y-8 py-10 text-sm leading-relaxed">
      <div>
        <h1 className="font-display text-3xl">Terms of Service</h1>
        <p className="mt-2 text-muted-foreground">
          Last updated: August 6, 2026. These terms cover the hosted service at
          livevariant.com and livevariant.link, operated by LiveVariant ("we",
          "us"). If you are using LiveVariant on someone else's deployment, that
          operator's terms apply instead, not these.
        </p>
      </div>

      <Section title="1. Built to be self-hosted">
        <p>
          LiveVariant is open source software under the GNU AGPL v3. The
          intended, first-class way to run it is your own deployment, on your
          own infrastructure, under your own control: the{" "}
          <a
            className="underline"
            href="https://github.com/livevariant/livevariant"
          >
            source code
          </a>{" "}
          and a one-click deploy exist for exactly that. The hosted service is a
          convenience we run so you can try LiveVariant, and for tests where
          convenience matters more than control. It is offered with no
          guarantees of any kind. If your tests matter to your business, run
          your own deployment, or contact{" "}
          <a className="underline" href="mailto:hi@livevariant.com">
            hi@livevariant.com
          </a>{" "}
          about commercial support.
        </p>
      </Section>

      <Section title="2. Acceptance">
        <p>
          By creating an account, creating a test on the hosted service, or
          using links a hosted test serves, you agree to these terms and to the{" "}
          <Link className="underline" to="/privacy">
            Privacy Policy
          </Link>
          . If you do not agree, do not use the hosted service; you can run the
          same software yourself under the AGPL instead.
        </p>
      </Section>

      <Section title="3. The service">
        <p>
          The hosted service serves adaptive A/B tests: variant assignment,
          redirects, image serving, conversion tracking, and statistics. We may
          change, add, or remove any part of it at any time without notice.
        </p>
      </Section>

      <Section title="4. Your account">
        <p>
          You are responsible for what happens under your account and for
          keeping access to your email secure. Stats secrets and manage links
          carry full authority over a test: anyone you share them with can read
          and manage that test.
        </p>
      </Section>

      <Section title="5. Your tests and content">
        <p>
          Test configurations, variants, and uploaded images remain yours. You
          grant us the license needed to store and serve them, which is the
          entire point of the service. You are responsible for the content you
          serve and for having the rights to it, and for your tests complying
          with the laws that apply to you, including consent requirements for
          your own visitors.
        </p>
      </Section>

      <Section title="6. No availability promise, no retention promise">
        <p>
          We make NO commitment that the hosted service will be available,
          performant, or uninterrupted, and NO commitment that tests, data,
          statistics, or accounts will be retained. We may suspend or delete any
          test, any content, or any account at any time, with or without reason,
          with or without notice. This is not hostility; it is what a free
          convenience service can honestly promise, which is nothing. The
          self-hosted deployment exists precisely so that you can have real
          guarantees, made by you, to yourself.
        </p>
      </Section>

      <Section title="7. Acceptable use">
        <p>
          Do not use the hosted service for anything unlawful, for phishing,
          malware, or deceptive redirects, for content you lack rights to, or to
          track people in ways they have not agreed to. We remove tests and
          accounts that do.
        </p>
      </Section>

      <Section title="8. Fees">
        <p>
          The hosted service is currently free. We may introduce paid tiers or
          limits in the future; existing usage will get reasonable notice.
        </p>
      </Section>

      <Section title="9. Disclaimer of warranty">
        <p>
          THERE IS NO WARRANTY FOR THE SERVICE, TO THE EXTENT PERMITTED BY
          APPLICABLE LAW. EXCEPT WHEN OTHERWISE STATED IN WRITING, WE PROVIDE
          THE SERVICE "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR
          IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
          MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE ENTIRE RISK
          AS TO THE QUALITY AND PERFORMANCE OF THE SERVICE IS WITH YOU.
        </p>
      </Section>

      <Section title="10. Limitation of liability">
        <p>
          IN NO EVENT, UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN
          WRITING, WILL WE BE LIABLE TO YOU FOR DAMAGES, INCLUDING ANY GENERAL,
          SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR
          INABILITY TO USE THE SERVICE (INCLUDING BUT NOT LIMITED TO LOSS OF
          DATA, LOST PROFITS, INACCURATE TEST RESULTS, OR FAILURE OF THE SERVICE
          TO OPERATE), EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH
          DAMAGES. WHERE LIABILITY CANNOT BE EXCLUDED, IT IS LIMITED TO THE
          AMOUNT YOU PAID US FOR THE SERVICE IN THE TWELVE MONTHS BEFORE THE
          CLAIM, WHICH FOR A FREE SERVICE IS ZERO.
        </p>
      </Section>

      <Section title="11. Indemnification">
        <p>
          You will defend and hold us harmless from claims arising out of your
          tests, your content, or your use of the service in violation of these
          terms.
        </p>
      </Section>

      <Section title="12. Termination">
        <p>
          You can stop using the service at any time. We can terminate or
          suspend access at any time as described in section 6. Sections 9
          through 11 survive termination.
        </p>
      </Section>

      <Section title="13. Changes to these terms">
        <p>
          We may update these terms; the date above changes when we do.
          Continued use after a change is acceptance of the new terms.
        </p>
      </Section>

      <Section title="14. Governing law">
        <p>
          These terms are governed by the laws of the Netherlands, and disputes
          belong to the competent court there, except where the law of your
          residence grants you mandatory protections.
        </p>
      </Section>

      <Section title="15. Contact">
        <p>
          Questions, commercial support, or anything else:{" "}
          <a className="underline" href="mailto:hi@livevariant.com">
            hi@livevariant.com
          </a>
          .
        </p>
      </Section>
    </div>
  );
}
