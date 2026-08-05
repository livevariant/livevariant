/**
 * Outbound email: magic sign-in links and address verification. Resend
 * is called over plain fetch (their SDK is a fetch wrapper; the
 * dependency buys nothing a Worker needs), and the vendor stays
 * contained in this file so tests inject a recorder and a future
 * switch is a one-file change.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendEmail = (email: OutgoingEmail) => Promise<void>;

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

function linkEmail(input: {
  lead: string;
  action: string;
  url: string;
}): Omit<OutgoingEmail, "to" | "subject"> {
  const href = escapeHtml(input.url);
  return {
    html:
      `<p>${input.lead}</p>` +
      `<p><a href="${href}">${input.action}</a></p>` +
      `<p>Or paste this link into your browser:<br>${href}</p>` +
      `<p>If you did not request this, ignore this email.</p>`,
    text:
      `${input.lead}\n\n${input.url}\n\n` +
      `If you did not request this, ignore this email.`
  };
}

export function magicLinkEmail(to: string, url: string): OutgoingEmail {
  return {
    to,
    subject: "Sign in to LiveVariant",
    ...linkEmail({
      lead: "Click to sign in to LiveVariant:",
      action: "Sign in",
      url
    })
  };
}

export function verificationEmail(to: string, url: string): OutgoingEmail {
  return {
    to,
    subject: "Verify your email for LiveVariant",
    ...linkEmail({
      lead: "Confirm this address to finish creating your LiveVariant account:",
      action: "Verify email",
      url
    })
  };
}

export function resendMailer(options: ResendOptions): SendEmail {
  return async email => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: options.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text
      })
    });
    if (!res.ok) {
      // Surfaced to Better Auth, which reports a send failure rather
      // than a silent "check your inbox" for a mail that never left.
      throw new Error(`email send failed (${res.status})`);
    }
  };
}
