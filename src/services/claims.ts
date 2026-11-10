import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { claims, type Claim } from "../db/schema";
import { sha256 } from "../lib/crypto";
import { env } from "../env";
import { claimTenant } from "./tenants";

/**
 * One-time codes that attach an email to an anonymous workspace. This is the
 * agent-first "anonymous → claim" flow: an agent can provision with no human,
 * and a human later claims it (with an emailed code) to make it permanent.
 */

// No 0/O/1/I/L to keep codes easy to read and type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function claimCode(length = 6): string {
  const bytes = new Uint8Array(length);
  const out: string[] = [];
  const max = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= max) continue;
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

export interface CreatedClaim {
  id: string;
  email: string;
  /** The raw code. Only ever returned when email delivery is not wired up. */
  code: string;
  expiresAt: Date;
}

export async function createClaim(
  tenantId: string,
  email: string,
  name?: { firstName?: string | null; lastName?: string | null },
): Promise<CreatedClaim> {
  const normalized = email.trim().toLowerCase();
  const code = claimCode();
  const expiresAt = new Date(Date.now() + env.claimTtlMs);

  /**
   * A resend supersedes the code before it: two live codes for one address is two
   * ways in, and the older one is the one nobody is looking at any more.
   */
  await db
    .update(claims)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(claims.tenantId, tenantId),
        eq(claims.email, normalized),
        isNull(claims.consumedAt),
      ),
    );

  const [row] = await db
    .insert(claims)
    .values({
      tenantId,
      email: normalized,
      firstName: name?.firstName?.trim() || null,
      lastName: name?.lastName?.trim() || null,
      codeHash: sha256(code),
      expiresAt,
    })
    .returning();

  if (!row) throw new Error("Failed to create claim");
  return { id: row.id, email: row.email, code, expiresAt };
}

/**
 * Verify a claim code and make the workspace permanent. Returns the claim row,
 * or null when the code is wrong, expired, or already used.
 */
export async function verifyClaim(
  claimId: string,
  code: string,
): Promise<Claim | null> {
  const [row] = await db
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.id, claimId),
        eq(claims.codeHash, sha256(code.trim().toUpperCase())),
        isNull(claims.consumedAt),
        gt(claims.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) return null;

  await db
    .update(claims)
    .set({ consumedAt: new Date() })
    .where(eq(claims.id, row.id));
  await claimTenant(row.tenantId, row.email, {
    firstName: row.firstName,
    lastName: row.lastName,
  });

  return row;
}

/**
 * Verify by email + code (no claim id), used by the agent sign-in flow
 * (`/api/auth/agent/verify-code`). Consumes the newest matching claim.
 */
export async function verifyClaimByEmail(
  email: string,
  code: string,
): Promise<Claim | null> {
  const [row] = await db
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.email, email.trim().toLowerCase()),
        eq(claims.codeHash, sha256(code.trim().toUpperCase())),
        isNull(claims.consumedAt),
        gt(claims.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(claims.createdAt))
    .limit(1);

  if (!row) return null;

  await db
    .update(claims)
    .set({ consumedAt: new Date() })
    .where(eq(claims.id, row.id));
  await claimTenant(row.tenantId, row.email, {
    firstName: row.firstName,
    lastName: row.lastName,
  });

  return row;
}
