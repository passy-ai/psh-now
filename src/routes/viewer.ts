/**
 * "Am I signed in?", for the pages that are not the app.
 *
 * The marketing header says Log in and Get started to everyone, because the page is
 * served from cache and has no idea who is asking. Someone who is already signed in is
 * then offered a login they do not need, on the site they just came from.
 *
 * The browser asks this endpoint with its own cookies, and gets back the answer to that
 * one question. It carries a session id and an email and nothing else: no key, no usage,
 * no channel, and an empty answer for anyone who is not signed in.
 */
import { Elysia } from "elysia";
import { auth } from "../auth";

export const viewerRoutes = new Elysia({ prefix: "/api/v1" }).get("/viewer", async ({ request }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response(JSON.stringify({ signedIn: false }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return new Response(
    JSON.stringify({
      signedIn: true,
      // The local part of the address is enough to confirm it is the right account; the
      // full address is not needed to render "Go to dashboard".
      email: session.user.email,
      name: session.user.name ?? null,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
});
