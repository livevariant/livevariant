/**
 * Outbound email, which for this module means exactly one thing: the
 * magic sign-in link. Resend is called over plain fetch (their SDK is a
 * fetch wrapper; the dependency buys nothing a Worker needs), and the
 * vendor stays contained in this file so tests inject a recorder and a
 * future switch is a one-file change.
 */

export type SendMagicLink = (to: string, url: string) => Promise<void>;

export interface ResendOptions {
  apiKey: string;
  /** e.g. "LiveVariant <login@mail.livevariant.com>" */
  from: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function resendMagicLink(options: ResendOptions): SendMagicLink {
  return async (to, url) => {
    const href = escapeHtml(url);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: options.from,
        to: [to],
        subject: "Sign in to LiveVariant",
        html:
          `<p>Click to sign in to LiveVariant:</p>` +
          `<p><a href="${href}">Sign in</a></p>` +
          `<p>Or paste this link into your browser:<br>${href}</p>` +
          `<p>If you did not request this, ignore this email.</p>`,
        text:
          `Sign in to LiveVariant:\n\n${url}\n\n` +
          `If you did not request this, ignore this email.`
      })
    });
    if (!res.ok) {
      // Surfaced to Better Auth, which reports a send failure rather
      // than a silent "check your inbox" for a mail that never left.
      throw new Error(`magic link email failed (${res.status})`);
    }
  };
}
