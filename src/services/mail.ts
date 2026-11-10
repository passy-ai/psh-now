import { env } from "../env";

/**
 * One mail path, two transports, because those are the two shapes a self-hoster actually
 * has: an SMTP URL (their own Postfix, Gmail app password, SES, Postmark) or a Resend key.
 * Nothing here is required to develop - `PSH_LOG_CODE=1` prints the code instead - but a
 * deployed instance with no transport cannot sign anyone in, so the server says so loudly
 * at boot rather than at the sign-in screen (`warnIfUnconfigured`).
 */

export type MailTransport = "smtp" | "resend" | "none";

export function mailTransport(): MailTransport {
  if (env.smtpUrl && env.mailFrom) return "smtp";
  if (env.resendApiKey && env.mailFrom) return "resend";
  return "none";
}

export function mailConfigured(): boolean {
  return mailTransport() !== "none";
}

let smtp: import("nodemailer").Transporter | null = null;

async function smtpTransport(): Promise<import("nodemailer").Transporter> {
  if (smtp) return smtp;
  const nodemailer = await import("nodemailer");
  // `SMTP_URL` carries the credentials and the TLS intent, e.g.
  // smtps://user:pass@smtp.example.com:465. nodemailer reads that shape directly.
  smtp = nodemailer.createTransport(env.smtpUrl);
  return smtp;
}

/**
 * The claim code, by email. Claims used to be handed to the browser instead - a code
 * on the sign-in screen is a code anyone reading the screen can use, so a public host
 * now emails it and refuses when no transport is configured.
 */
export async function sendClaimCodeEmail(input: {
  to: string;
  code: string;
  minutes: number;
}): Promise<void> {
  const { to, code, minutes } = input;
  await sendMail({
    to,
    subject: `${code} is your psh.now claim code`,
    text:
      `Your psh.now claim code is ${code}.\n\n` +
      `It expires in ${minutes} minutes and can be used once.\n` +
      `If you did not ask for this, ignore this email and the code expires on its own.\n\n` +
      `${env.publicBaseUrl}\n`,
    html:
      `<p>Your psh.now claim code:</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-family:ui-monospace,monospace">${code}</p>` +
      `<p>It expires in ${minutes} minutes and can be used once.</p>` +
      `<p>If you did not ask for this, ignore this email - the code expires on its own.</p>` +
      `<p><a href="${env.publicBaseUrl}">${env.publicBaseUrl}</a></p>`,
  });
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send one message. Throws on failure so a caller can decide: sign-in treats a failed
 * send as a 502 rather than pretending an email went out.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const transport = mailTransport();
  if (transport === "none") {
    throw new Error(
      "Mail is not configured: set SMTP_URL and MAIL_FROM, or RESEND_API_KEY and MAIL_FROM.",
    );
  }

  if (transport === "smtp") {
    const tx = await smtpTransport();
    await tx.sendMail({
      from: env.mailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.mailFrom,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend rejected the message (${response.status}): ${detail.slice(0, 200)}`);
  }
}

/**
 * Called once at boot. A production instance with no transport and no log-code fallback is
 * a sign-in dead end, and finding that out from a user is worse than one line in the log.
 */
export function warnIfUnconfigured(): void {
  if (env.isProduction && !mailConfigured()) {
    console.warn(
      "[psh.now] no mail transport configured: set SMTP_URL and MAIL_FROM, or RESEND_API_KEY " +
        "and MAIL_FROM. Until then email sign-in cannot deliver a code.",
    );
  }
}
