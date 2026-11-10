import { env } from "../env";

/**
 * Reversible encryption for secrets we must be able to show again — namely the
 * agent API key, so a paired operator can retrieve it. We still store the
 * SHA-256 hash for authentication; this encrypted copy exists only to reveal.
 *
 * AES-256-GCM, key derived from PSH_SECRET. A database dump alone is useless
 * without the secret.
 */

let cachedKey: ArrayBuffer | null = null;

async function key(): Promise<ArrayBuffer> {
  if (!cachedKey) {
    cachedKey = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.secret),
    );
  }
  return cachedKey;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", await key(), "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      k,
      new TextEncoder().encode(plain) as BufferSource,
    ),
  );
  return `${b64(iv)}.${b64(ciphertext)}`;
}

export async function decryptSecret(payload: string): Promise<string | null> {
  try {
    const [ivPart, ctPart] = payload.split(".");
    if (!ivPart || !ctPart) return null;
    const k = await crypto.subtle.importKey("raw", await key(), "AES-GCM", false, [
      "decrypt",
    ]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivPart) as BufferSource },
      k,
      unb64(ctPart) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
