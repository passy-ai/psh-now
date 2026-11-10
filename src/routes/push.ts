import { Elysia, t } from "elysia";
import { requireTenantOrDevice } from "../lib/tenant-auth";
import {
  countSubscriptions,
  getVapid,
  removeSubscription,
  saveSubscription,
  sendPushToTenant,
} from "../services/push";

export const pushRoutes = new Elysia({ prefix: "/api/v1/push" })
  /** Public: the VAPID public key the browser subscribes with. */
  .get("/public-key", async () => {
    const vapid = await getVapid();
    return { publicKey: vapid.publicKey };
  })

  /** Register this browser's push subscription. */
  .post(
    "/subscribe",
    async ({ request, body }) => {
      const { tenant, device } = await requireTenantOrDevice(request.headers);
      await saveSubscription(
        tenant.id,
        device?.id ?? null,
        body.subscription,
        request.headers.get("user-agent"),
      );
      return { subscribed: true };
    },
    {
      body: t.Object({
        subscription: t.Object({
          endpoint: t.String(),
          keys: t.Object({ p256dh: t.String(), auth: t.String() }),
        }),
      }),
    },
  )

  .post(
    "/unsubscribe",
    async ({ body }) => {
      await removeSubscription(body.endpoint);
      return { unsubscribed: true };
    },
    { body: t.Object({ endpoint: t.String() }) },
  )

  .get("/status", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    return { subscriptions: await countSubscriptions(tenant.id) };
  })

  /** Send a real push to this workspace's devices (works with the app closed). */
  .post("/test", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const sent = await sendPushToTenant(tenant.id, {
      title: "psh.now",
      body: "Push is working on this device.",
      tag: "psh-test",
      url: "/app",
    });
    return { sent };
  });
