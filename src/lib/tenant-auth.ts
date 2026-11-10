import type { Device, Tenant } from "../db/schema";
import { apiKeyFromHeaders } from "./crypto";
import { unauthorized } from "./http";
import { findTenantByApiKey } from "../services/tenants";
import { findDeviceByToken } from "../services/devices";

/** Resolve the authenticated tenant from request headers. Throws 401. */
export async function requireTenant(headers: Headers): Promise<Tenant> {
  const apiKey = apiKeyFromHeaders(headers);
  if (!apiKey) throw unauthorized("Provide an API key via x-psh-key");

  const tenant = await findTenantByApiKey(apiKey);
  if (!tenant) throw unauthorized("Invalid API key");
  return tenant;
}

export interface AuthContext {
  tenant: Tenant;
  device: Device | null;
}

/**
 * Accept either a workspace API key (x-psh-key) or a paired device token
 * (x-psh-device). Returns the tenant plus the device when present.
 */
export async function requireTenantOrDevice(headers: Headers): Promise<AuthContext> {
  const deviceToken = headers.get("x-psh-device")?.trim();
  if (deviceToken) {
    const device = await findDeviceByToken(deviceToken);
    if (!device) throw unauthorized("Invalid or revoked device token");
    const { getTenant } = await import("../services/tenants");
    const tenant = await getTenant(device.tenantId);
    if (!tenant) throw unauthorized("Workspace no longer exists");
    return { tenant, device };
  }

  const tenant = await requireTenant(headers);
  return { tenant, device: null };
}

/** True when the request looks like it carries a psh.now API key. */
export function hasApiKey(headers: Headers): boolean {
  return apiKeyFromHeaders(headers) !== null;
}
