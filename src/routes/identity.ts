import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { authUser, tenants } from "../db/schema";
import { auth, lastOtp } from "../auth";
import { env } from "../env";
import { mailConfigured } from "../services/mail";
import { HttpError, badRequest, unauthorized } from "../lib/http";
import { isLocalRequest } from "../lib/plans";
import { encryptSecret } from "../lib/secrets";
import {
  claimTenant,
  createTenant,
  findTenantByApiKey,
  findTenantByEmail,
  getTenant,
  revealAccountKey,
} from "../services/tenants";

/**
 * The thin bridge between better-auth (identity + email OTP) and psh tenants
 * (the account of record). After a code is verified the browser gets its
 * account key back, so the rest of the app stays key-based.
 */
export const identityRoutes = new Elysia({ prefix: "/api/v1/auth" })
  /** Does an account with this email already exist? Drives sign-in vs sign-up. */
  .post(
    "/lookup",
    async ({ body }) => {
      const email = body.email.trim().toLowerCase();
      const tenant = await findTenantByEmail(email);
      const [identity] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, email))
        .limit(1);
      return { exists: !!(tenant || identity) };
    },
    { body: t.Object({ email: t.String({ minLength: 3, maxLength: 200 }) }) },
  )

  /** Send (or resend) the one-time code. */
  .post(
    "/otp",
    async ({ body, request }) => {
      const email = body.email.trim().toLowerCase();
      // better-auth answers INVALID_EMAIL, which surfaced here as a 500 "Something went
      // wrong" for a typo the caller can fix.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw badRequest("Enter a valid email address");
      }
      // better-auth deliberately answers "ok" even when the send throws, so that a caller
      // cannot probe which addresses exist. That makes a missing mail transport invisible
      // to the person trying to sign in, so the one case that is ours to report is checked
      // here, before anything is sent: the instance cannot deliver codes at all.
      const local = isLocalRequest(request);
      if (!mailConfigured() && !local) {
        throw new HttpError(
          503,
          "This instance cannot send sign-in email yet: set SMTP_URL and MAIL_FROM, or " +
            "RESEND_API_KEY and MAIL_FROM. On a laptop the code is printed to the server log.",
          "mail_unconfigured",
        );
      }
      try {
        await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
      } catch (err) {
        /**
         * The one-time code is stored before the send, so a local run that has nowhere
         * to send it carries on with the code below. Anywhere else a failed send is a
         * failure: answering ok would send the user to a code field that never fills.
         */
        if (!local) {
          const message = err instanceof Error ? err.message : "Email delivery failed";
          console.error("[otp] send failed:", message);
          throw new HttpError(502, `Could not send the sign-in code: ${message}`, "upstream");
        }
      }
      // Dev only: hand the code back so the UI can offer a copy button. Keyed on
      // logCode, not devClaim: refusing the free token grant (PSH_DEV_CLAIM=0, which is how
      // the payment path is tested) must not also take away the ability to sign in.
      /**
       * Even with dev codes switched on, only a request from this machine gets one: a
       * public host that was never marked production must not print a sign-in code into
       * a stranger's browser. The deployed host did exactly that.
       */
      const devCode = env.logCode && local ? lastOtp.get(email) : undefined;
      return { ok: true, devCode };
    },
    { body: t.Object({ email: t.String({ minLength: 3, maxLength: 200 }) }) },
  )

  /** After better-auth verifies the code, link the identity to a psh tenant. */
  .post(
    "/connect",
    async ({ request, body }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) throw unauthorized("Sign in first");
      const email = session.user.email.toLowerCase();
      const authUserId = session.user.id;

      const [identity] = await db
        .select()
        .from(authUser)
        .where(eq(authUser.id, authUserId))
        .limit(1);

      // Already linked: hand back the same account key.
      if (identity?.tenantId) {
        const tenant = await getTenant(identity.tenantId);
        const key = tenant
          ? ((await revealAccountKey(tenant)) ?? body.userKey ?? null)
          : null;
        if (key) return { userKey: key, tenantId: identity.tenantId };
      }

      // Prefer an account that already has this email…
      let tenant = await findTenantByEmail(email);
      // …otherwise adopt the anonymous workspace this browser already holds.
      if (!tenant && body.userKey) {
        const existing = await findTenantByApiKey(body.userKey);
        if (existing && !existing.email) tenant = existing;
      }
      if (!tenant) tenant = (await createTenant()).tenant;

      if (!tenant.email) {
        tenant =
          (await claimTenant(tenant.id, email, {
            firstName: identity?.firstName ?? null,
            lastName: identity?.lastName ?? null,
          })) ?? tenant;
      }

      // Make the account key recoverable if it came from the browser.
      if (body.userKey && !tenant.apiKeyEnc) {
        await db
          .update(tenants)
          .set({ apiKeyEnc: await encryptSecret(body.userKey), updatedAt: new Date() })
          .where(eq(tenants.id, tenant.id));
      }

      await db
        .update(authUser)
        .set({ tenantId: tenant.id, updatedAt: new Date() })
        .where(eq(authUser.id, authUserId));

      const key = (await revealAccountKey(tenant)) ?? body.userKey ?? null;
      if (!key) throw badRequest("Could not recover the account key for this account");
      return { userKey: key, tenantId: tenant.id };
    },
    { body: t.Object({ userKey: t.Optional(t.String({ maxLength: 200 })) }) },
  );
