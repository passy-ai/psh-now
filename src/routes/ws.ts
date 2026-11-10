import { Elysia, t } from "elysia";
import { findDeviceByToken, touchDevice } from "../services/devices";
import { findKeyAuth, getTenant } from "../services/tenants";
import { broadcast, registerSocket, unregisterSocket } from "../lib/realtime";
import { recordDecision } from "../services/decisions";
import { getPromptAny, listPendingForChannels, listPrompts } from "../services/prompts";
import { canAccessChannel, listSessions } from "../services/sessions";
import { serializeForApprover } from "./hook";
import { env } from "../env";

interface SocketContext {
  tenantId: string;
  /** null when the connection is authenticated by an API key, not a device. */
  deviceId: string | null;
}

/** Per-socket auth context keyed by Elysia's stable connection id. */
const socketContext = new Map<string, SocketContext>();

interface IncomingFrame {
  type?: string;
  promptId?: string;
  approved?: boolean;
  reason?: string;
  /** For a batched route: the option id the human chose. */
  decision?: string;
  /** The human's own words - makes the outcome `answered` instead of yes/no. */
  answer?: string;
}

/**
 * Elysia/Bun may hand us an already-parsed object (Elysia's JSON parser runs by
 * default), or raw bytes depending on configuration. Normalise either shape.
 */
async function parseFrame(raw: unknown): Promise<IncomingFrame> {
  const isBinary =
    raw instanceof ArrayBuffer ||
    ArrayBuffer.isView(raw) ||
    (typeof Blob !== "undefined" && raw instanceof Blob);

  if (raw && typeof raw === "object" && !isBinary) {
    return raw as IncomingFrame;
  }

  return JSON.parse(await decodeMessage(raw)) as IncomingFrame;
}

/**
 * Elysia/Bun may hand us a string, Buffer, ArrayBuffer, Blob, or a wrapped
 * object depending on runtime and binaryType. Normalise all of them to text.
 */
async function decodeMessage(raw: unknown): Promise<string> {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && raw instanceof Blob) return await raw.text();
  if (raw && typeof raw === "object" && "data" in raw) {
    return decodeMessage((raw as { data: unknown }).data);
  }
  return String(raw);
}

export const wsRoutes = new Elysia().ws("/ws", {
  query: t.Object({ token: t.String({ minLength: 8, maxLength: 64 }) }),

  async open(ws) {
    const token = ws.data.query.token;

    // Authenticate with a device token, or with a workspace API key (the app's
    // "key is the login" path).
    const device = await findDeviceByToken(token);
    let ctx: SocketContext | null = null;
    if (device) {
      ctx = { tenantId: device.tenantId, deviceId: device.id };
    } else {
      // Only an approving key may open the dashboard stream. `ask` keys
      // (agents, channel keys, join links) can request approvals but not watch.
      const auth = await findKeyAuth(token);
      if (auth && auth.scope !== "ask") {
        ctx = { tenantId: auth.tenant.id, deviceId: null };
      }
    }

    if (!ctx) {
      ws.send(JSON.stringify({ type: "error", code: "unauthorized" }));
      ws.close(4401, "unauthorized");
      return;
    }

    socketContext.set(ws.id, ctx);
    registerSocket(ctx.tenantId, ctx.deviceId ?? `key:${ctx.tenantId}`, ws);
    if (device) void touchDevice(device.id);

    const owned = await listPrompts(ctx.tenantId, { status: "pending", limit: 20 });
    const sharedChannelIds = (await listSessions(ctx.tenantId))
      .filter((c) => c.shared)
      .map((c) => c.id);
    const sharedPending = await listPendingForChannels(sharedChannelIds, 20);
    const pending = [...owned, ...sharedPending];
    const tenant = await getTenant(ctx.tenantId);

    ws.send(
      JSON.stringify({
        type: "hello",
        workspace: {
          id: ctx.tenantId,
          name: tenant?.name ?? "Workspace",
          baseUrl: env.publicBaseUrl,
        },
        device: device
          ? { id: device.id, name: device.name }
          : { id: null, name: "API key" },
        pending: await serializeForApprover(pending),
        serverTime: new Date().toISOString(),
      }),
    );
  },

  async message(ws, raw) {
    const ctx = socketContext.get(ws.id);
    if (!ctx) return;

    let frame: IncomingFrame;
    try {
      frame = await parseFrame(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "bad_json" }));
      return;
    }

    switch (frame.type) {
      case "ping": {
        if (ctx.deviceId) void touchDevice(ctx.deviceId);
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        return;
      }

      case "decision": {
        if (!frame.promptId || (typeof frame.approved !== "boolean" && !frame.answer)) {
          ws.send(JSON.stringify({ type: "error", code: "bad_decision" }));
          return;
        }
        // A typed answer is its own outcome, so `approved` is optional with it.
        const answer =
          typeof frame.answer === "string" && frame.answer.trim()
            ? frame.answer.trim().slice(0, 2000)
            : null;

        // Allow the owner or any account the channel is shared with.
        const prompt = await getPromptAny(frame.promptId);
        if (!prompt) {
          ws.send(JSON.stringify({ type: "error", code: "no_prompt" }));
          return;
        }
        const allowed =
          prompt.tenantId === ctx.tenantId ||
          (prompt.sessionId ? await canAccessChannel(ctx.tenantId, prompt.sessionId) : false);
        if (!allowed) {
          ws.send(JSON.stringify({ type: "error", code: "forbidden" }));
          return;
        }

        const result = await recordDecision({
          promptId: frame.promptId,
          tenantId: prompt.tenantId,
          approved: frame.approved === true,
          reason: frame.reason ?? null,
          decision: frame.decision ?? null,
          answer,
          deviceId: ctx.deviceId,
          // Lets every node fan the frame out to accounts the channel is shared with.
          sessionId: prompt.sessionId,
        });

        ws.send(JSON.stringify({
          type: "decision.ack",
          promptId: frame.promptId,
          applied: result.outcome === "applied",
          // Why it did not apply. Without this the client painted its checkmark for a decision
          // the server had refused, which is the card claiming something that never happened.
          reason: result.outcome,
          message: result.message ?? null,
        }));
        if (result.outcome === "applied" && ctx.deviceId) void touchDevice(ctx.deviceId);
        return;
      }

      case "subscribe": {
        // Reserved for future per-prompt subscriptions; dashboards get all events.
        ws.send(JSON.stringify({ type: "subscribed" }));
        return;
      }

      default:
        ws.send(JSON.stringify({ type: "error", code: "unknown_type" }));
    }
  },

  close(ws) {
    const ctx = socketContext.get(ws.id);
    if (ctx) {
      unregisterSocket(ctx.tenantId, ws);
      broadcast(ctx.tenantId, { type: "device.disconnected", deviceId: ctx.deviceId });
      socketContext.delete(ws.id);
    }
  },
});
