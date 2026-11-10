import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { db } from "./db";
import { authAccount, authSession, authUser, authVerification } from "./db/schema";
import { env } from "./env";
import { mailConfigured, sendMail } from "./services/mail";
import { sha256 } from "./lib/crypto";

/**
 * better-auth owns identity: email + one-time code. Everything else in psh.now
 * stays key-based — after sign-in we hand the browser its account key back.
 *
 * In dev (PSH_DEV_CLAIM) the generated code is logged and returned to the UI so
 * a human can copy it. In production it is only ever emailed.
 */
export const lastOtp = new Map<string, string>();

export const auth = betterAuth({
  // A 64-hex derivation of the app secret: long enough for better-auth and
  // stable across restarts (so sessions survive a redeploy).
  secret: sha256(env.secret),
  baseURL: env.publicBaseUrl,
  basePath: "/api/auth",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: authUser,
      session: authSession,
      account: authAccount,
      verification: authVerification,
    },
  }),
  user: {
    additionalFields: {
      firstName: { type: "string", required: false },
      lastName: { type: "string", required: false },
      // The psh tenant this identity owns. Set by our own link step, never by
      // the client, so it is not an input field.
      tenantId: { type: "string", required: false, input: false },
    },
  },
  emailAndPassword: { enabled: false },
  // A browser treats localhost and 127.0.0.1 as different origins, and better-auth answers
  // 403 invalid origin for anything not listed. Both spellings, and only outside production,
  // because the public host has no business trusting a loopback Origin header.
  trustedOrigins: env.isProduction
    ? [env.publicBaseUrl]
    : [
        env.publicBaseUrl,
        "http://localhost:4321",
        "http://127.0.0.1:4321",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ],
  advanced: {
    // Locally we serve plain http; a Secure cookie would be dropped.
    useSecureCookies: env.isProduction,
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 5 * 60,
      storeOTP: "hashed",
      allowedAttempts: 5,
      generateOTP: ({ email }) => {
        // Cryptographically random, and remembered only in dev.
        const bytes = new Uint8Array(4);
        crypto.getRandomValues(bytes);
        const otp = String(100000 + (new DataView(bytes.buffer).getUint32(0) % 900000));
        lastOtp.set(email.toLowerCase(), otp);
        return otp;
      },
      sendVerificationOTP: async ({ email, otp, type }) => {
        // `PSH_LOG_CODE=1` in .env prints the code to the local console. It is
        // hard-off in production, so unlike PSH_DEV_CLAIM it cannot be switched
        // on in the deployed environment.
        if (env.logCode) {
          console.log(`\n  psh.now code for ${email} (${type}): ${otp}\n`);
          return;
        }
        if (!mailConfigured()) {
          // Fail loudly rather than return 200 for an email that was never sent:
          // the alternative is a user staring at a code field that can never fill.
          throw new Error(
            "Sign-in email cannot be sent: no mail transport is configured. " +
              "Set SMTP_URL and MAIL_FROM, or RESEND_API_KEY and MAIL_FROM.",
          );
        }
        await sendMail({
          to: email,
          subject: `${otp} is your psh.now code`,
          text:
            `Your psh.now sign-in code is ${otp}.\n\n` +
            `It expires in 5 minutes and can be used once.\n` +
            `If you did not ask to sign in, ignore this email.\n\n` +
            `${env.publicBaseUrl}`,
          html:
            `<p>Your psh.now sign-in code:</p>` +
            `<p style="font-size:28px;letter-spacing:6px;font-family:ui-monospace,monospace">${otp}</p>` +
            `<p>It expires in 5 minutes and can be used once.</p>` +
            `<p>If you did not ask to sign in, ignore this email.</p>` +
            `<p><a href="${env.publicBaseUrl}">${env.publicBaseUrl}</a></p>`,
        });
      },
    }),
  ],
});

export type Auth = typeof auth;
