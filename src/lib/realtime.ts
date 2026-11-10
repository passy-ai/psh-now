/**
 * In-process WebSocket hub: maps a tenant to its connected supervisor devices.
 * A single tenant may have several phones/dashboards connected at once.
 */

export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
}

interface Connection {
  socket: RealtimeSocket;
  deviceId: string;
}

const channels = new Map<string, Set<Connection>>();

export function registerSocket(
  tenantId: string,
  deviceId: string,
  socket: RealtimeSocket,
): void {
  let set = channels.get(tenantId);
  if (!set) {
    set = new Set();
    channels.set(tenantId, set);
  }
  set.add({ socket, deviceId });
}

export function unregisterSocket(tenantId: string, socket: RealtimeSocket): void {
  const set = channels.get(tenantId);
  if (!set) return;

  for (const conn of set) {
    if (conn.socket === socket) {
      set.delete(conn);
      break;
    }
  }
  if (set.size === 0) channels.delete(tenantId);
}

/** Send a JSON frame to every connected device for a tenant. */
export function broadcast(tenantId: string, payload: unknown): number {
  const set = channels.get(tenantId);
  if (!set || set.size === 0) return 0;

  const frame = JSON.stringify(payload);
  let delivered = 0;
  for (const conn of set) {
    try {
      conn.socket.send(frame);
      delivered++;
    } catch {
      // Dead socket; it will be cleaned up on close.
    }
  }
  return delivered;
}

/**
 * Send a live frame to every device watching a channel: the owning tenant's
 * devices plus each device signed in to an account the channel is shared with.
 * Without this, a decision on a shared channel only appears live for its
 * owner; everyone else has to refresh to see it.
 *
 * Owner-only on any share lookup failure, one frame beats no frame.
 */
export async function broadcastToWatchers(
  ownerTenantId: string,
  sessionId: string | null | undefined,
  payload: unknown,
): Promise<number> {
  const targets = new Set<string>([ownerTenantId]);
  if (sessionId) {
    try {
      const { sharedTenantIds } = await import("../services/sessions");
      for (const t of await sharedTenantIds(sessionId)) targets.add(t);
    } catch (err) {
      console.error("[realtime] share lookup failed, broadcasting owner only", err);
    }
  }
  let delivered = 0;
  for (const t of targets) delivered += broadcast(t, payload);
  return delivered;
}

export function onlineDeviceCount(tenantId: string): number {
  return channels.get(tenantId)?.size ?? 0;
}

/** Device ids with a live WebSocket for this tenant. */
export function onlineDeviceIds(tenantId: string): Set<string> {
  const ids = new Set<string>();
  const set = channels.get(tenantId);
  if (set) for (const conn of set) ids.add(conn.deviceId);
  return ids;
}

export function connectedTenantCount(): number {
  return channels.size;
}
