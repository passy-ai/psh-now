import { createHmac } from "node:crypto";
import { env } from "../env";
import { timingSafeEqual } from "./crypto";
import { forbidden, gone } from "./http";

/**
 * A short-lived, signed right to download one channel's history.
 *
 * An export has to arrive as a real download: the browser has to navigate to a
 * URL that answers `content-disposition: attachment`. That request cannot carry
 * the account key in a header (a navigation sets none), and a key in the query
 * string would end up in history, logs and the Referer header. So the client
 * trades its key for this token, and the token is the only credential the
 * download URL needs.
 *
 * The claim names the channel *and* the account: a token cannot be edited to
 * reach another channel, and the account's access is checked again on redeem, so
 * a share revoked a second after the press stops working immediately.
 */

interface ExportClaim {
  /** Channel id. */
  c: string;
  /** Account whose access was checked when the token was minted. */
  t: string;
  /** Expiry, ms since epoch. */
  e: number;
}

/** Long enough for a slow phone to start the download, short enough to be stale-proof. */
const TTL_MS = 5 * 60_000;

const signature = (payload: string): string =>
  createHmac("sha256", env.secret).update(payload).digest("base64url");

export function signExportToken(channelId: string, tenantId: string): string {
  const claim: ExportClaim = { c: channelId, t: tenantId, e: Date.now() + TTL_MS };
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifyExportToken(token: string): { channelId: string; tenantId: string } {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) throw forbidden("This export link is incomplete");

  // Constant time: the signature is the only thing between a stranger and a
  // channel's history.
  if (!timingSafeEqual(mac, signature(payload))) throw forbidden("This export link is not valid");

  let claim: Partial<ExportClaim>;
  try {
    claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ExportClaim>;
  } catch {
    throw forbidden("This export link is not valid");
  }
  if (typeof claim.c !== "string" || typeof claim.t !== "string" || typeof claim.e !== "number") {
    throw forbidden("This export link is not valid");
  }
  if (Date.now() > claim.e) throw gone("This export link expired. Press Export again.");
  return { channelId: claim.c, tenantId: claim.t };
}
