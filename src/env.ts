/**
 * Centralised, validated environment configuration.
 * Bun automatically loads .env into process.env.
 */
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return parsed;
}

/**
 * A hostname this project used to run on, mapped to the one it runs on now.
 *
 * PUBLIC_BASE_URL is the canonical host: every link, canonical tag, sitemap entry and prompt is
 * built from it. When a deployment's environment still names the old host, the app should not
 * keep advertising it, so this rewrites it at startup. A self hosted instance sets its own
 * value and never hits this; the mapping is a migration for our own instance only.
 */
const LEGACY_HOSTS: Record<string, string> = {
  "https://psh.abslm.nl": "https://psh.now",
  "http://psh.abslm.nl": "https://psh.now",
  "https://www.psh.abslm.nl": "https://psh.now",
};

function canonicalise(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");
  return LEGACY_HOSTS[trimmed] ?? trimmed;
}

export const env = (() => {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  // The encryption key for recoverable secrets. Must never be the dev default
  // in production — a DB dump plus a known key would expose every agent key.
  const DEV_SECRET = "dev-insecure-secret-change-me";
  const secret = process.env.PSH_SECRET ?? DEV_SECRET;
  if (isProduction && (secret === DEV_SECRET || secret.length < 16)) {
    throw new Error(
      "PSH_SECRET must be set to a long random value in production (it encrypts recoverable keys).",
    );
  }

  return {
    nodeEnv,
    isProduction,
    port: int("PORT", 3000),
    host: process.env.HOST ?? "0.0.0.0",
    publicBaseUrl: canonicalise(required("PUBLIC_BASE_URL", "http://localhost:3000")),
    databaseUrl: required("DATABASE_URL", "postgres://localhost:5432/psh.now"),
    defaultTimeoutMs: int("DEFAULT_TIMEOUT_MS", 90 * 1000),
    pairingTtlMs: int("PAIRING_TTL_MS", 10 * 60 * 1000),
    /** How long an unclaimed (anonymous) workspace lives before cleanup. */
    unclaimedTtlMs: int("UNCLAIMED_TTL_MS", 7 * 24 * 60 * 60 * 1000),
    /** How long a claim code stays valid. */
    claimTtlMs: int("CLAIM_TTL_MS", 15 * 60 * 1000),
    /**
     * The free ladder, in requests (one approval = two requests). Lower these to
     * reach the wall quickly while testing: the dashboard meter, the limit
     * message and the top-up path all follow whatever is set here.
     */
    freeRequests: int("PSH_FREE_REQUESTS", 20),
    claimedRequests: int("PSH_CLAIMED_REQUESTS", 100),
    /**
     * Dev only: return the claim/verify code in the API response instead of
     * emailing it. Fail-closed in production — only on if explicitly set.
     */
    devClaim: isProduction
      ? process.env.PSH_DEV_CLAIM === "1"
      : (process.env.PSH_DEV_CLAIM ?? "1") !== "0",
    /**
     * Dev only: print verification codes to the server console, so a local run
     * can be signed into without a mail provider. Hard-off in production — this
     * one cannot be switched on in the deployed environment at all.
     */
    logCode: !isProduction && (process.env.PSH_LOG_CODE ?? "1") !== "0",
    /** Secret used to encrypt recoverable agent keys at rest. */
    secret,
    /**
     * Dodo Payments. The mode is explicit rather than inferred from the key: a key
     * pasted into the wrong environment then fails instead of charging a card.
     */
    dodoApiKey: process.env.DODO_API_KEY ?? "",
    dodoWebhookSecret: process.env.DODO_WEBHOOK_SECRET ?? "",
    dodoMode: (process.env.PSH_DODO_MODE === "live" ? "live" : "test") as "test" | "live",
    // Web Push (VAPID). Optional: if unset, keys are generated and persisted.
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:hello@psh.now",
    /**
     * Mail. A deployed instance cannot sign anyone in without one of these, so both
     * shapes are supported: an SMTP URL (any provider, including a local Postfix) or a
     * Resend API key. `mailFrom` is required by both.
     */
    smtpUrl: process.env.SMTP_URL ?? "",
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    mailFrom: process.env.MAIL_FROM ?? "",
    // Optional: serve HTTPS/WSS directly from Bun with no reverse proxy.
    tlsCertFile: process.env.TLS_CERT_FILE ?? "",
    tlsKeyFile: process.env.TLS_KEY_FILE ?? "",
  } as const;
})();
