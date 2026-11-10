import { Elysia, t } from "elysia";
import { requireTenantOrDevice } from "../lib/tenant-auth";
import { notFound } from "../lib/http";
import { updateProfile } from "../services/tenants";
import type { Tenant } from "../db/schema";
import {
  acceptInvite,
  acceptInviteByToken,
  declineInvite,
  listInvitesForEmail,
  peekInvite,
} from "../services/invites";

/** The public shape of a profile. Never includes email or keys. */
function publicProfile(tenant: Tenant) {
  return {
    name: [tenant.firstName, tenant.lastName].filter(Boolean).join(" ") || null,
    bio: tenant.bio,
    link: tenant.link,
    joinedAt: tenant.createdAt,
  };
}

export const profileRoutes = new Elysia({ prefix: "/api/v1" })
  /** The signed-in account's profile (adds its private email). */
  .get("/profile", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    return { profile: { ...publicProfile(tenant), email: tenant.email } };
  })

  /** Update the public bio + link. */
  .patch(
    "/profile",
    async ({ request, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const updated = await updateProfile(tenant.id, { bio: body.bio, link: body.link });
      return { profile: publicProfile(updated ?? tenant) };
    },
    {
      body: t.Object({
        bio: t.Optional(t.String({ maxLength: 160 })),
        link: t.Optional(t.String({ maxLength: 300 })),
      }),
    },
  )

  /** Pending channel invites addressed to my email. */
  .get("/me/invites", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    if (!tenant.email) return { invites: [] };
    const rows = await listInvitesForEmail(tenant.email);
    return {
      invites: rows.map((r) => ({
        id: r.id,
        channelId: r.channelId,
        email: r.email,
        expiresAt: r.expiresAt,
      })),
    };
  })

  .post(
    "/me/invites/:id/accept",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      if (!tenant.email) throw notFound("Register an email first");
      const ok = await acceptInvite(tenant.id, tenant.email, params.id);
      if (!ok) throw notFound("Invite not found or already used");
      return { accepted: true };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  .post(
    "/me/invites/:id/decline",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      if (!tenant.email) throw notFound("Register an email first");
      return { declined: await declineInvite(tenant.email, params.id) };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /** Public: inspect an invite token (for the /invite/:token page). */
  .get(
    "/invites/:token",
    async ({ params }) => {
      const invite = await peekInvite(params.token);
      if (!invite) throw notFound("Invite not found");
      return {
        invite: {
          id: invite.id,
          email: invite.email,
          channelId: invite.channelId,
          channelName: invite.channelName,
          expiresAt: invite.expiresAt,
          expired: invite.expiresAt.getTime() < Date.now(),
          accepted: !!invite.acceptedAt,
          declined: !!invite.declinedAt,
          revoked: !!invite.revokedAt,
        },
      };
    },
    { params: t.Object({ token: t.String({ minLength: 4, maxLength: 64 }) }) },
  )

  /** Accept an invite by its emailed token (signed-in account). */
  .post(
    "/invites/:token/accept",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const ok = await acceptInviteByToken(tenant.id, params.token);
      if (!ok) throw notFound("Invite not found or already used");
      return { accepted: true };
    },
    { params: t.Object({ token: t.String({ minLength: 4, maxLength: 64 }) }) },
  );
