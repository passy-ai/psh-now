-- Who the client says it is, from the MCP `initialize` handshake's `clientInfo`.
--
-- `prompts.agent` is whatever a caller puts in a body field; agents using the MCP
-- transport never send one, so every MCP request used to be recorded as the constant
-- "mcp" and two agents on one workspace were indistinguishable. The handshake already
-- carries a name and a version - it was simply never read.
--
-- Idempotent, like 0002: a half-applied ALTER must be re-runnable at boot.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "client_name" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "client_title" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "client_version" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "client_seen_at" timestamp with time zone;
