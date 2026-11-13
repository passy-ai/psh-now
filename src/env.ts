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

export const env = (() => {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  // The encryption key for recoverable secrets. Must never be the dev default
  // in production, a DB dump plus a known key would expose every agent key.
  const DEV_SECRET = "dev-insecure-secret-change-me";
  const secret = process.env.PSH_SECRET ?? DEV_SECRET;
  if (isProduction && (secret === DEV_SECRET || secret.length < 16)) {
    throw new Error(
      "PSH_SECRET must be set to a long random value in production (it encrypts recoverable keys).",
    );
  }

  /**
   * Is this instance serving a public host or a laptop? `NODE_ENV` is the honest
   * signal and it was not set on the deployed host, which turned every dev-only path
   * back on: codes printed into the sign-in screen and uncapped token grants. So the
   * default now also needs the base URL to look local - a public host is never
   * "development" just because nobody exported the variable.
   */
  const publicBaseUrl = required("PUBLIC_BASE_URL", "http://localhost:3000").replace(/\/$/, "");
  const localBase = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(publicBaseUrl);
  /** Dev conveniences default on for a laptop, and require an explicit 1 anywhere else. */
  const devDefaultsOn = !isProduction && localBase;
  const devFlag = (name: string): boolean =>
    devDefaultsOn ? (process.env[name] ?? "1") !== "0" : process.env[name] === "1";

  return {
    nodeEnv,
    isProduction,
    /** True when the public base URL points at this machine. */
    localBase,
    port: int("PORT", 3000),
    host: process.env.HOST ?? "0.0.0.0",
    publicBaseUrl,
    databaseUrl: required("DATABASE_URL", "postgres://localhost:5432/psh.now"),
    defaultTimeoutMs: int("DEFAULT_TIMEOUT_MS", 90 * 1000),
    pairingTtlMs: int("PAIRING_TTL_MS", 10 * 60 * 1000),
    /** How long an unclaimed (anonymous) workspace lives before cleanup. */
    unclaimedTtlMs: int("UNCLAIMED_TTL_MS", 7 * 24 * 60 * 60 * 1000),
    /** How long a claim code stays valid. */
    claimTtlMs: int("CLAIM_TTL_MS", 15 * 60 * 1000),
    /**
     * The free ladder, in requests (one approval = two requests). An anonymous
     * workspace gets 20 before it has to register; registering raises it to 100.
     * Lower either to reach the wall quickly while testing: the dashboard meter,
     * the limit message and the top-up path all follow whatever is set here.
     */
    freeRequests: int("PSH_FREE_REQUESTS", 20),
    claimedRequests: int("PSH_CLAIMED_REQUESTS", 100),
    /**
     * Requests one workspace may add for nothing while no payment provider is
     * approved. The checkout link is the blocker, not the intent to charge, so this
     * keeps the top-up button usable until Dodo is live - capped, because a host that
     * cannot take money must not quietly become unlimited free capacity.
     */
    directTokensMax: int("PSH_DIRECT_TOKENS_MAX", 1000),
    /**
     * Dev only: return the claim/verify code in the API response instead of
     * emailing it. Fail-closed in production, only on if explicitly set.
     */
    devClaim: devFlag("PSH_DEV_CLAIM"),
    /**
     * Dev only: print verification codes to the server console, so a local run
     * can be signed into without a mail provider. Hard-off in production, this
     * one cannot be switched on in the deployed environment at all.
     */
    logCode: devFlag("PSH_LOG_CODE"),
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
    vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:push@passy.ai",
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
