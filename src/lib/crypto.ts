import { shortId } from "./ids";

/** SHA-256 hex digest. Used for opaque random tokens (never for passwords). */
export function sha256(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

/** Constant-time comparison of two hex strings of equal length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Prefixes are part of the product vocabulary:
//   psh_user_  the account key (sign in + approve)
//   psh_agent_ a key an agent/channel sends
//   psh_admin_ the account secret (manage)
export type ApiKeyMode = "user" | "agent" | "test" | "admin";

export interface GeneratedApiKey {
  /** Full key, shown to the user exactly once. */
  key: string;
  /** SHA-256 hash persisted in Postgres. */
  hash: string;
  /** Short display prefix, e.g. "psh_user_a1b2c3d4". */
  prefix: string;
}

const API_KEY_BODY_LENGTH = 24; // -> "psh_user_" + 24 = 33 chars total

/** Generate a new tenant API key of the form `psh_<mode>_<24 base62>`. */
export function generateApiKey(mode: ApiKeyMode = "agent"): GeneratedApiKey {
  const body = shortId(API_KEY_BODY_LENGTH);
  const key = `psh_${mode}_${body}`;
  return {
    key,
    hash: sha256(key),
    prefix: `psh_${mode}_${body.slice(0, 8)}`,
  };
}

/** Extract the api key from supported headers (x-psh-key, Authorization). */
export function apiKeyFromHeaders(headers: Headers): string | null {
  const direct = headers.get("x-psh-key");
  if (direct) return direct.trim();

  const auth = headers.get("authorization");
  if (auth) {
    const [scheme, token] = auth.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) return token.trim();
    if (scheme?.toLowerCase() === "psh" && token) return token.trim();
  }
  return null;
}
