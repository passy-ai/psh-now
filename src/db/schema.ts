import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  newPairingToken,
  newPromptId,
  newTenantId,
  shortId,
} from "../lib/ids";

/** Lifecycle of an approval request. */
export const promptStatus = pgEnum("prompt_status", [
  "pending",
  "approved",
  "denied",
  /**
   * The human replied with text instead of yes/no. Neither approved nor
   * denied: the agent has to read `answer` and act on it.
   */
  "answered",
  "expired",
]);

/** Coarse risk bucket derived from the command text. */
export const promptRisk = pgEnum("prompt_risk", [
  "low",
  "medium",
  "high",
  "critical",
  "unknown",
]);

/**
 * One underlying ask that a recommended route resolves. These are the questions
 * the agent would otherwise have had to ask one at a time.
 */
export interface RouteAsk {
  /** The question or decision, e.g. "Which shell profile should I source?" */
  question: string;
  /** What the recommendation does about it, e.g. "Use zsh". */
  answer: string;
}

/** One selectable path through a route. */
export interface RouteOption {
  /** Stable id the agent receives back as `decision`. */
  id: string;
  /** Short human label, e.g. "zsh + SIGTERM + exponential backoff". */
  label: string;
  /** Why this option, in one line. */
  detail?: string;
  /** The route this option represents, the collapsed asks. */
  asks?: RouteAsk[];
  /** Marks the option the agent recommends. Exactly one should be true. */
  recommended?: boolean;
}

/**
 * A batch decision: several asks collapsed into one tap. The agent does the
 * reasoning and presents a recommended route; the human confirms the route
 * rather than answering each question.
 */
export interface PromptRoute {
  /** One-line summary of what the route accomplishes. */
  summary: string;
  options: RouteOption[];
  /** Why the recommended option is the recommendation. */
  rationale?: string;
}

/**
 * Primary keys are short base62 strings (<= 32 chars) so every public URL
 * stays YouTube-like and clean. Foreign keys are plain `text` to match.
 */
const shortPk = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => shortId(11));

export const tenants = pgTable(
  "tenants",
  {
    id: shortPk(),
    name: text("name").notNull().default("Untitled workspace"),
    /** SHA-256 of the raw API key. The raw key is shown exactly once. */
    apiKeyHash: text("api_key_hash").notNull(),
    /** First 16 chars of the raw key, safe to display. */
    apiKeyPrefix: text("api_key_prefix").notNull(),
    /** SHA-256 of the account SECRET key (manage scope). Shown exactly once. */
    secretKeyHash: text("secret_key_hash"),
    /** First 16 chars of the raw secret key, safe to display. */
    secretKeyPrefix: text("secret_key_prefix"),
    /** Encrypted raw secret key, so the owner can copy it again later. */
    secretKeyEnc: text("secret_key_enc"),
    /** anonymous | free | token | enterprise */
    plan: text("plan").notNull().default("anonymous"),
    /** Remaining prepaid request tokens (bought in packages). */
    tokenBalance: integer("token_balance").notNull().default(0),
    /**
     * When the one-per-account free entry pack was taken. Null means it is still
     * there. The grant and this stamp are one statement, so it cannot be taken twice.
     */
    freePackAt: timestamp("free_pack_at", { withTimezone: true }),
    /** Set when a human claims the workspace with an email. */
    email: text("email"),
    /** Password hash for email + password sign-in (set from the dashboard). */
    passwordHash: text("password_hash"),
    /** Encrypted raw account key, so password sign-in can return it. */
    apiKeyEnc: text("api_key_enc"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    /** One-line public bio (<=160 chars) and one http(s) link. */
    bio: text("bio"),
    link: text("link"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Unclaimed workspaces expire; null once claimed. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("tenants_api_key_hash_idx").on(t.apiKeyHash)],
);

/**
 * Additional agent API keys for a workspace. We store only the SHA-256 hash,
 * so a raw key is shown exactly once (at creation). A paired device can mint a
 * new one at any time, which is how a user recovers a lost key.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Agent key"),
    /**
     * What this key may do. "ask" keys (agents, channel keys, join links) can
     * only create/read their own approvals. "manage" keys (the account login)
     * can approve and administer the account.
     */
    scope: text("scope").notNull().default("ask"),
    /**
     * When set, this key is bound to one channel and routes to it. The binding
     * dies with the channel: a key whose channel is gone must fail loudly (401),
     * never quietly start a replacement channel.
     */
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    keyHash: text("key_hash").notNull(),
    /** Encrypted raw key, so a paired operator can reveal it. */
    keyEnc: text("key_enc"),
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_tenant_idx").on(t.tenantId),
  ],
);

/**
 * One-time codes that attach an email to an (anonymous) workspace, making it
 * permanent. Mirrors here.now's anonymous-publish → claim flow.
 */
export const claims = pgTable(
  "claims",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("claims_code_hash_idx").on(t.codeHash),
    index("claims_tenant_idx").on(t.tenantId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Unnamed connection"),
    slug: text("slug"),
    /** Accent colour (hex) so channels are easy to tell apart. */
    color: text("color"),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    agent: text("agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sessions_tenant_idx").on(t.tenantId, t.lastSeenAt),
    uniqueIndex("sessions_slug_idx").on(t.slug),
  ],
);

/**
 * Sharing a channel (connection) with another account id, so that account can
 * see and approve its requests. That is the whole "invite" model.
 */
export const channelShares = pgTable(
  "channel_shares",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    channelId: text("channel_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sharedWith: text("shared_with")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_shares_unique_idx").on(t.channelId, t.sharedWith),
    index("channel_shares_shared_idx").on(t.sharedWith),
  ],
);

export const devices = pgTable(  "devices",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Unnamed device"),
    userAgent: text("user_agent"),
    /** Client address + Cloudflare country code, captured when it paired. */
    ip: text("ip"),
    country: text("country"),
    /** SHA-256 of the device token. Set by the service layer. */
    tokenHash: text("token_hash").notNull(),
    pairedAt: timestamp("paired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("devices_token_hash_idx").on(t.tokenHash),
    index("devices_tenant_idx").on(t.tenantId),
  ],
);

export const pairingTokens = pgTable(
  "pairing_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** SHA-256 of the pairing token embedded in the QR URL. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pairing_tokens_token_hash_idx").on(t.tokenHash),
    index("pairing_tokens_tenant_idx").on(t.tenantId),
  ],
);

/**
 * An invite to a channel. Two flavours, one token:
 *  - addressed to an email that has no account yet, or
 *  - **open**: no email at all, so the link itself is the invite (the owner
 *    copies it from the share menu). Whoever opens it signs up and accepts.
 * On acceptance a channel_share is created, the same grant an email invite
 * creates directly.
 */
export const channelInvites = pgTable(
  "channel_invites",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    channelId: text("channel_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Null for an open (link-only) invite. */
    email: text("email"),
    tokenHash: text("token_hash").notNull(),
    /**
     * The raw token, so the owner can be shown their own live link again (the
     * panel has no "create" step, the link is simply there). Null on rows
     * minted before this existed; the route rotates those once. Lookup still
     * goes through the hash, so a DB reader cannot *find* a channel by token.
     */
    token: text("token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Who accepted it, this is how "joined using the link" is known. */
    acceptedBy: text("accepted_by").references(() => tenants.id, {
      onDelete: "set null",
    }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    /** Set when the owner revokes the link (it can no longer be accepted). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_invites_token_idx").on(t.tokenHash),
    index("channel_invites_email_idx").on(t.email),
    index("channel_invites_channel_idx").on(t.channelId),
  ],
);

/** Small key/value store (e.g. persisted VAPID keys). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One-time links that let another agent join the SAME account. The holder
 * redeems the code for a fresh channel key on this tenant, so several machines
 * or sandboxes can share one account while still anonymous. This is the
 * "connect another agent" link the user is guided to hand out.
 */
export const joinTokens = pgTable(
  "join_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** SHA-256 of the join token embedded in the join URL. */
    tokenHash: text("token_hash").notNull(),
    /** Optional channel to bind the issued key to. */
    sessionId: text("session_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("join_tokens_token_hash_idx").on(t.tokenHash),
    index("join_tokens_tenant_idx").on(t.tenantId),
  ],
);

/** Browser Web Push subscriptions, so alerts reach a closed tab/phone. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => shortId(11)),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: text("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("push_subs_endpoint_idx").on(t.endpoint),
    index("push_subs_tenant_idx").on(t.tenantId),
  ],
);

export const prompts = pgTable(
  "prompts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(newPromptId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: text("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    /** The API key that created this request. Lets an `ask` key read back only
     *  the requests it created, never the whole channel or account. */
    createdByKeyId: text("created_by_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    /** Short headline, e.g. "Delete node_modules and reinstall". */
    title: text("title").notNull().default("Approval request"),
    /** Full body: the command, the intended action, or a clarification ask. */
    message: text("message").notNull(),
    /** Optional machine kind for grouping: command | action | question. */
    kind: text("kind").notNull().default("action"),
    cwd: text("cwd"),
    agent: text("agent"),
    risk: promptRisk("risk").notNull().default("unknown"),
    riskReasons: jsonb("risk_reasons").$type<string[]>().notNull().default([]),
    /**
     * A recommended route: several underlying asks collapsed into one decision.
     * Null for a plain single yes/no request. See `PromptRoute`.
     */
    route: jsonb("route").$type<PromptRoute | null>(),
    /** Which route option the human took. Null when denied or unbatched. */
    decision: text("decision"),
    /**
     * The human's own words, when they answered instead of approving/denying
     * (`status = "answered"`). A clarification, a partial yes, a constraint to
     * respect, anything that is not a bare yes or no.
     */
    answer: text("answer"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: promptStatus("status").notNull().default("pending"),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("prompts_tenant_status_idx").on(t.tenantId, t.status),
    index("prompts_created_idx").on(t.createdAt),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    promptId: text("prompt_id").references(() => prompts.id, {
      onDelete: "set null",
    }),
    deviceId: text("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_log_tenant_idx").on(t.tenantId, t.createdAt)],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
/* ------------------------------------------------------------------ *
 * better-auth tables
 *
 * Identity lives here (email + OTP sessions). The psh tenant stays the
 * account of record: each auth user links to exactly one tenant via
 * `tenantId`, and the account key is what the browser actually uses.
 * ------------------------------------------------------------------ */

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  /** The psh tenant this identity owns. */
  tenantId: text("tenant_id").references(() => tenants.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_session_user_idx").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_account_user_idx").on(t.userId)],
);

export const authVerification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuthUser = typeof authUser.$inferSelect;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ChannelShare = typeof channelShares.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type PairingToken = typeof pairingTokens.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
export type PromptStatus = Prompt["status"];
export type PromptRisk = Prompt["risk"];
export type AuditEntry = typeof auditLog.$inferSelect;

// Re-export so callers can import id helpers from either place.
export { newPairingToken, newPromptId, newTenantId };
