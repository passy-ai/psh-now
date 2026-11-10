/**
 * Short, URL-safe, YouTube-style identifiers.
 *
 * Alphabet is base62 (A-Z a-z 0-9) which reads cleanly in URLs and avoids the
 * ambiguous punctuation of base64url. IDs are generated with a CSPRNG and are
 * rejection-sampled so every character is uniformly distributed.
 *
 * All public identifiers stay well under 32 characters.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALPHABET_LEN = ALPHABET.length; // 62
const MAX_UNBIASED = 256 - (256 % ALPHABET_LEN); // largest multiple of 62 <= 256

/** Generate a random base62 string of `size` characters. */
export function shortId(size = 11): string {
  if (size <= 0 || size > 32) {
    throw new RangeError(`shortId size must be between 1 and 32 (got ${size})`);
  }

  const bytes = new Uint8Array(size);
  const out: string[] = [];

  // Rejection sample to remove modulo bias.
  while (out.length < size) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= MAX_UNBIASED) continue;
      out.push(ALPHABET[byte % ALPHABET_LEN]!);
      if (out.length === size) break;
    }
  }

  return out.join("");
}

/** Standard lengths used across the system (all <= 32). */
export const ID_LENGTHS = {
  tenant: 11,
  prompt: 11,
  pairingToken: 22,
  deviceToken: 24,
  /**
   * A channel's public URL ending. Long and random on purpose: the URL is the
   * only thing standing between a stranger and an ask-only key for that channel,
   * so it must not be guessable from the channel's name (`/main` was).
   */
  channelUrl: 16,
} as const;

/** A tenant slug / workspace id, e.g. "dev77x99abc". */
export const newTenantId = () => shortId(ID_LENGTHS.tenant);
/** A prompt / approval request id, e.g. "pr8x1k2m..." (URL-safe). */
export const newPromptId = () => shortId(ID_LENGTHS.prompt);
/** A short-lived pairing token embedded in a QR URL. */
export const newPairingToken = () => shortId(ID_LENGTHS.pairingToken);
/** A long-lived device session token held by the phone. */
export const newDeviceToken = () => shortId(ID_LENGTHS.deviceToken);
/**
 * A channel's public URL ending (`/c/<channelUrl>`). 16 random base62
 * characters, minted once when the channel is created and never changed. The
 * link is what the owner hands to an agent, so it has to survive renames and
 * every later edit.
 */
export const newChannelUrl = () => shortId(ID_LENGTHS.channelUrl);
