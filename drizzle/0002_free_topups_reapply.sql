-- Defensive re-apply of the free top-up columns.
--
-- 0001_free_topups.sql added these, but the deployment that shipped it came up with
-- the columns absent while drizzle's ledger recorded the migration as applied: the
-- container starts the server even when migration fails (the CMD retries ten times and
-- then execs anyway), so a failed ALTER left a host that 500s on every route touching
-- `tenants` without failing the deploy.
--
-- This migration is a no-op where the columns exist, so running it is always safe.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "free_top_ups" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "free_top_up_at" timestamp with time zone;
